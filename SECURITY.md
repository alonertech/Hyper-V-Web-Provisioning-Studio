# Security Policy

## Scope

This project manages Windows Hyper-V resources and can perform privileged operations. Security issues should therefore be reported carefully.

## Do not publish sensitive information

Do not open a public issue containing:

- Passwords or credential material
- Private keys
- Certificate private material
- Access tokens
- Production connection strings
- Confidential hostnames or IP addresses
- Sensitive audit records

## Reporting

For a suspected security vulnerability, use a private GitHub security advisory or another private contact mechanism configured by the project owner. Do not post exploit details publicly before a fix/coordination process is established.

## Current security posture

V3.1.0 includes loopback web binding by default, server-side validation, reviewed PowerShell operations, DPAPI-protected alternate credential storage, RBAC checks, certificate validation for the selected WinRM HTTPS path, and SHA-256 chained audit events.

The development package retains PowerShell `ExecutionPolicy Bypass` for compatibility with unsigned development builds. This should be replaced with signed PowerShell and signed installation media for a commercial release.

## Security roadmap

Planned/desired enterprise controls include formal threat modeling, signed binaries/scripts, SBOM and dependency governance, centralized authentication/SSO, stronger session controls, SIEM integration, vulnerability disclosure process, and independent security review.
