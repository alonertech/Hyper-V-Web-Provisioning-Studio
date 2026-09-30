# Hyper-V Web Provisioning Studio

**Version:** 3.1.0 Professional  
**Platform:** Windows / Hyper-V  
**Project status:** Public development / lab validation

**Release/source note:** The `v3.1.0` tag is the frozen source snapshot for the published v3.1.0 release. The `main` branch may contain post-release fixes and ongoing development. Do not move or recreate the existing `v3.1.0` tag to match `main`; publish future changes under a new version tag after validation.

Hyper-V Web Provisioning Studio is a Windows-native web management tool for Hyper-V VM provisioning and selected VM/network management tasks. It is designed for local and remote Hyper-V administration in standalone/workgroup and domain-capable Windows environments.

## What this release contains

### VM management

- Hyper-V VM inventory and details
- Provision VM workflow
- VM lifecycle actions including Start, Shutdown and TurnOff
- Native VMConnect console launch
- VM modification:
  - Expand virtual disk size
  - Move VM storage directory
  - Change a VM network adapter's virtual switch

### Virtual switch management

- Existing virtual switch inventory
- Switch details and connected-VM count
- Create Internal, Private and External switches
- Modify supported switch settings
- Physical adapter inventory for External switches

### Provisioning and platform features

- Generation 1 and Generation 2 VMs
- Static startup memory
- VHDX provisioning
- ISO installation media
- First-power-on ISO boot workflow
- Manual ISO eject
- Secure Boot
- vTPM
- VLAN tagging
- Pre-flight validation
- Job cancellation and rollback

### Professional management layer

- Embedded JSON management store
- Persistent job history
- Human-readable job summaries/details
- VM templates
- Optional provisioning policies
- Windows-identity RBAC: Viewer, Auditor, Operator and Administrator
- SHA-256 chained audit events
- Audit integrity verification and export
- Dashboard and target overview
- Management-data backup/export

## Architecture

```text
Browser
   |
   | REST + SSE (local portal)
   v
Express Management API
   |
   +-- RBAC
   +-- Policy engine
   +-- Template service
   +-- Embedded management store
   +-- Audit service
   +-- Job manager
   |
   v
PowerShell execution layer
   |
   +-- Local Hyper-V
   +-- Remote WinRM / Negotiate
   +-- Native VMConnect
   +-- First-boot watcher
```

Hyper-V remains authoritative for VM and switch state. The embedded store contains management metadata, templates, policies, history and audit records.

## Internet connectivity

The application is intended to perform its normal Hyper-V management work without Internet access.

The development repository does **not** commit the bundled Node runtime or `node_modules`; those are distributed with the tested portable release ZIP. The source tree can therefore be developed like a normal Node/PowerShell project, while the portable release remains self-contained for offline/lab deployment.

Normal runtime communication is local or private-network based:

- `127.0.0.1:3000` for the desktop portal
- WinRM to the selected remote Hyper-V host when remote management is used
- Native VMConnect connectivity when a VM console is opened

Internet-dependent Windows services, browser extensions, updates, licensing systems, or future cloud integrations are outside the current core management path.

## Prerequisites

For the source tree:

- Windows 10/11 or supported Windows Server release with Hyper-V
- Windows PowerShell 5.1+
- Hyper-V PowerShell module
- Node.js compatible with the project dependencies for development
- Administrator rights for the management operations being performed

For remote Hyper-V management:

- Network connectivity from the management machine to the target
- WinRM configured on the target
- Appropriate Windows/Hyper-V authorization
- `Negotiate` authentication path available

## Running the tested portable build

Download the **V3.1.0 Professional ZIP** from the GitHub Release assets and run:

```text
Start-HyperVPortal.bat
```

Run the launcher as Administrator.

The portable release includes its bundled Node runtime and dependencies, so it is the recommended package for an Internet-isolated/lab installation.

## Source development

Clone the repository and install development dependencies:

```powershell
npm ci
```

Start the application during development with:

```powershell
npm start
```

The production-style portable launcher is:

```text
Start-HyperVPortal.bat
```

## Validation

Run the included prerequisite/regression script from an elevated Windows PowerShell console:

```powershell
.\tools\Test-HyperVWebV3.ps1
```

For a remote target:

```powershell
.\tools\Test-HyperVWebV3.ps1 -TargetHost HVHOST02
```

The test script checks PowerShell syntax, WinRM authentication requirements, first-boot ISO behavior, Hyper-V inventory functions, Professional management APIs, audit integrity and V3.1 VM/switch modification features.

## Data and privacy

Runtime management data is written beneath:

```text
C:\ProgramData\HyperV-Web-V3\
```

A fresh public repository intentionally contains **empty runtime directories only**. Local job history, audit records and management state from a real environment must not be committed to the repository.

Do not commit:

- Credentials or passwords
- Private keys or certificates
- Real enterprise hostnames/IP addresses that should remain private
- Personal user data
- Production audit/job exports

## Security status

This is a public development/lab release, not a certified enterprise security product.

Current controls include:

- Loopback-only web binding by default
- Server-side request validation
- Fixed/reviewed PowerShell operations rather than arbitrary HTTP script execution
- Windows DPAPI protection for alternate credential files
- SHA-256 chained audit records
- Role-based management API permissions
- Certificate validation for the selected WinRM HTTPS path

On a fresh installation, the first Windows identity that starts the portal is persisted as the initial Administrator mapping. Subsequent identities that are not explicitly mapped receive the least-privileged Viewer role.

The current development package still uses PowerShell `ExecutionPolicy Bypass` for compatibility with unsigned development builds. A commercial distribution should move to signed PowerShell, signed binaries/installer media, formal code-signing policy, threat modeling, dependency governance and an enterprise authentication architecture.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Roadmap

See [`ROADMAP.md`](ROADMAP.md).

## Contributing

Bug reports, feature requests, architecture discussions and pull requests are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.

## License

A public source repository does not by itself grant broad permission to reuse or redistribute the code. The project owner should select and add an explicit open-source license before encouraging third-party redistribution.

See [`LICENSE-CHOICE.md`](LICENSE-CHOICE.md).
