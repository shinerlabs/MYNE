import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstat, mkdir, open, readFile, rename, rm,
} from 'node:fs/promises';
import {
  dirname, isAbsolute, parse, resolve,
} from 'node:path';

export const ROUND_DEADLINE_INCIDENT_FILE = 'round-deadline-incidents.json';
export const ROUND_DEADLINE_VIOLATION_STAGES = new Set([
  'prepare-deadline-missed',
  'next-prebind-deadline-missed',
  'lock-deadline-missed',
  'settlement-deadline-missed',
]);

const MAX_INCIDENT_FILE_BYTES = 1_048_576;
const PROGRAM_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function safeRoundDeadlineIncidentPath(dataDir) {
  assert.equal(typeof dataDir, 'string', 'Worker data directory must be a string');
  assert.ok(dataDir && !dataDir.includes('\0'), 'Worker data directory is invalid');
  assert.ok(isAbsolute(dataDir), 'Worker data directory must be absolute');
  const root = resolve(dataDir);
  assert.notEqual(root, parse(root).root, 'Worker data directory cannot be the filesystem root');
  const path = resolve(root, ROUND_DEADLINE_INCIDENT_FILE);
  assert.equal(dirname(path), root, 'Round deadline incident path escaped the worker data directory');
  return { root, path };
}

const incidentId = ({ programId, roundId, stage, firstObservedAt }) => (
  `${programId}:${roundId}:${stage}:${firstObservedAt}`
);

const validateIncident = (incident, programId) => {
  assert.ok(incident && typeof incident === 'object' && !Array.isArray(incident), 'Incident is invalid');
  assert.equal(incident.programId, programId, 'Incident program id does not match this host');
  assert.ok(Number.isSafeInteger(incident.roundId) && incident.roundId >= 0, 'Incident round id is invalid');
  assert.ok(ROUND_DEADLINE_VIOLATION_STAGES.has(incident.stage), 'Incident stage is invalid');
  for (const name of ['firstObservedAt', 'lastObservedAt']) {
    assert.ok(Number.isSafeInteger(incident[name]) && incident[name] >= 0, `Incident ${name} is invalid`);
  }
  assert.ok(incident.lastObservedAt >= incident.firstObservedAt, 'Incident timestamps are out of order');
  assert.ok(Number.isSafeInteger(incident.occurrences) && incident.occurrences >= 1, 'Incident count is invalid');
  assert.ok(typeof incident.outcome === 'string' && incident.outcome.length <= 512, 'Incident outcome is invalid');
  assert.ok(
    incident.clearedAt === null
      || (Number.isSafeInteger(incident.clearedAt) && incident.clearedAt >= incident.lastObservedAt),
    'Incident cleared timestamp is invalid',
  );
  assert.equal(
    incident.id,
    incidentId(incident),
    'Incident id does not match its immutable identity',
  );
  return incident;
};

const emptyDocument = (programId) => ({ version: 1, programId, incidents: [] });

async function readIncidentDocument(path, programId) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDocument(programId);
    throw error;
  }
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Round deadline incident file must be a regular file');
  assert.ok(info.size <= MAX_INCIDENT_FILE_BYTES, 'Round deadline incident file is unexpectedly large');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed?.version, 1, 'Round deadline incident file version is unsupported');
  assert.equal(parsed?.programId, programId, 'Round deadline incident file belongs to another program');
  assert.ok(Array.isArray(parsed?.incidents), 'Round deadline incident list is invalid');
  const ids = new Set();
  for (const incident of parsed.incidents) {
    validateIncident(incident, programId);
    assert.ok(!ids.has(incident.id), 'Round deadline incident file contains a duplicate id');
    ids.add(incident.id);
  }
  return parsed;
}

async function writeIncidentDocument({ root, path, document }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  let renamed = false;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, path);
    renamed = true;
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function createRoundDeadlineIncidentLatch({ dataDir, programId }) {
  assert.match(String(programId || ''), PROGRAM_ID_PATTERN, 'Incident latch program id is invalid');
  const paths = safeRoundDeadlineIncidentPath(dataDir);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const document = await readIncidentDocument(paths.path, programId);
  let writeQueue = Promise.resolve();
  let revision = 0;
  let persistedRevision = 0;

  const activeIncidents = () => document.incidents
    .filter(({ clearedAt }) => clearedAt === null)
    .map((incident) => ({ ...incident }));
  const history = () => document.incidents.map((incident) => ({ ...incident }));
  const persist = () => {
    const targetRevision = revision;
    const operation = writeQueue
      .catch(() => {})
      .then(async () => {
        await writeIncidentDocument({ ...paths, document });
        persistedRevision = Math.max(persistedRevision, targetRevision);
      });
    writeQueue = operation;
    return operation;
  };

  const record = ({ roundId, stage, outcome = '', observedAt = Date.now() }) => {
    assert.ok(Number.isSafeInteger(roundId) && roundId >= 0, 'Incident round id is invalid');
    assert.ok(ROUND_DEADLINE_VIOLATION_STAGES.has(stage), 'Incident stage is invalid');
    assert.ok(Number.isSafeInteger(observedAt) && observedAt >= 0, 'Incident observation time is invalid');
    const normalizedOutcome = String(outcome || '').slice(0, 512);
    let incident = document.incidents.find((candidate) => (
      candidate.roundId === roundId && candidate.stage === stage && candidate.clearedAt === null
    ));
    if (incident) {
      return {
        incident: { ...incident },
        created: false,
        persisted: revision > persistedRevision ? persist() : Promise.resolve(),
      };
    } else {
      incident = {
        id: incidentId({ programId, roundId, stage, firstObservedAt: observedAt }),
        programId,
        roundId,
        stage,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        occurrences: 1,
        outcome: normalizedOutcome,
        clearedAt: null,
      };
      document.incidents.push(incident);
      revision += 1;
    }
    return { incident: { ...incident }, created: true, persisted: persist() };
  };

  const clearExact = async (acknowledgement, { clearedAt = Date.now() } = {}) => {
    assert.ok(typeof acknowledgement === 'string' && acknowledgement, 'Incident acknowledgement is required');
    assert.ok(Number.isSafeInteger(clearedAt) && clearedAt >= 0, 'Incident clear time is invalid');
    const incident = document.incidents.find(({ id }) => id === acknowledgement);
    assert.ok(incident, 'Incident acknowledgement does not match this incident history');
    if (incident.clearedAt !== null) return { ...incident, alreadyCleared: true };
    assert.ok(clearedAt >= incident.lastObservedAt, 'Incident clear time precedes its last observation');
    incident.clearedAt = clearedAt;
    revision += 1;
    await persist();
    return { ...incident };
  };

  return {
    path: paths.path,
    activeIncidents,
    history,
    record,
    clearExact,
    flush: () => (revision > persistedRevision ? persist() : writeQueue),
  };
}
