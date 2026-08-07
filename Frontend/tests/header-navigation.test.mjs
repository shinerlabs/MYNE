import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8');

test('desktop navigation uses readable link type and generous spacing', () => {
  assert.match(styles, /@media \(min-width: 1181px\)[\s\S]*\.main-nav \{[\s\S]*gap:\s*clamp\(26px, 2\.15vw, 36px\) !important/);
  assert.match(styles, /@media \(min-width: 1181px\)[\s\S]*\.nav-item \{[\s\S]*font-size:\s*clamp\(13px, \.95vw, 14px\) !important/);
});

test('tablet navigation never falls back to the legacy 7.5px labels', () => {
  const finalTabletRule = styles.slice(styles.lastIndexOf('@media (min-width: 721px) and (max-width: 900px)'));
  assert.match(finalTabletRule, /font-size:\s*clamp\(10px, 1\.35vw, 11\.5px\) !important/);
  assert.doesNotMatch(finalTabletRule, /font-size:\s*7\.5px/);
});

