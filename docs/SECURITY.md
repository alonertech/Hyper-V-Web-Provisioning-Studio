# V3 Professional Security Notes

- Loopback-only web binding by default.
- Server-side validation before Hyper-V commands run.
- Reviewed PowerShell scripts rather than arbitrary HTTP script text.
- Alternate credentials protected with Windows DPAPI via `Export-Clixml`.
- Audit records exclude passwords and are chained with SHA-256 hashes.
- RBAC applies to management API operations.
- WinRM HTTPS path uses certificate validation when selected; certificate-check bypass switches are not used.
- V3 development package retains `ExecutionPolicy Bypass` for compatibility with unsigned source builds. Commercial distribution should use signed scripts and signed installer media.
