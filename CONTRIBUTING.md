# Contributing

Thank you for helping improve Hyper-V Web Provisioning Studio.

## Before opening an issue

Please check existing Issues and Discussions first. For a reproducible bug, include:

- Windows edition/build
- Hyper-V host edition/build
- Local or remote target
- Standalone/workgroup or domain environment
- Relevant application version
- Exact operation being performed
- Sanitized error message and job/audit details
- Steps to reproduce

Never attach passwords, credential files, private keys, certificates containing private material, or confidential production configuration.

## Feature requests

Describe the administrative problem first, then the proposed behavior. Hyper-V management changes should include the expected effect on running VMs and host networking.

## Pull requests

Please:

1. Keep changes focused.
2. Preserve existing behavior unless the change explicitly requires it.
3. Update documentation for user-visible behavior.
4. Update validation checks when introducing new required behavior.
5. Do not commit runtime `ProgramData` data, secrets, or generated job artifacts.
6. Test PowerShell syntax on Windows PowerShell 5.1+.
7. Test both local and remote paths when the change affects target handling.

## Development principles

- Browser input is data, not executable PowerShell.
- Server-side validation is authoritative.
- Hyper-V state on the target host is authoritative.
- Destructive operations require explicit, bounded behavior.
- Audit records must remain secret-safe.
- Existing V2.x behavior should remain stable unless intentionally changed.
