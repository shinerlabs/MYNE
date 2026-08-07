# Security policy

MYNE is pre-launch and has not been represented as independently audited.

Report a suspected vulnerability through GitHub's private vulnerability reporting feature for
this repository. Include the affected commit, component, impact, reproducible steps, and a minimal
proof of concept. Do not test against Mainnet, interact with other users' funds, publish secrets,
or open a public issue containing exploit details.

Wallet seed phrases, keypair files, private RPC credentials, service-role keys, keeper keys, and
deployment credentials must never be shared in an issue or committed to the repository. Rotate a
credential immediately if it has appeared in a browser screenshot, chat, build log, or commit.
Browser `VITE_*` values are public: any hosted RPC key must be domain-restricted and rate-limited,
never reused by an administrator or keeper.

The maintainers will acknowledge a complete report, reproduce it in an isolated environment, and
coordinate remediation and disclosure. No response-time or bounty commitment is made unless a
separate program is published.
