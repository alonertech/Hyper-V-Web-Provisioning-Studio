# V3 Professional Feature Set

## Hyper-V operations retained from V2.9

Local and remote Hyper-V targets, hostname/IP target entry, WinRM Negotiate, HTTP or certificate-validated HTTPS, VM inventory, VM details, native VMConnect console, vSwitch management, VLAN access tagging, VHDX creation, ISO mounting, Gen 1/Gen 2, Secure Boot, vTPM, first-power-on ISO workflow, manual ISO eject, job cancellation, rollback, and browser/CMD lifecycle.

## Professional management capabilities

### Embedded management store
Persistent local data store for templates, policies, role mappings, job history, host snapshots, and audit events.

### RBAC
Viewer, Auditor, Operator, Administrator. The Windows identity running the portal is used as the local principal.

### Templates
Save repeatable VM hardware, network, storage, and security defaults and apply them to the provisioning form.

### Policies
Optional rules for Gen 2, Secure Boot, vTPM, minimum CPU/RAM, approved switches, and approved storage roots. No policy is enabled by default, preserving the V2 provisioning behavior.

### Audit
Audit events are stored persistently and chained with SHA-256 hashes. Integrity can be verified from the UI and audit history can be exported as JSON.

## VM modification

The Virtual Machines tab provides a Modify workflow for supported changes on an existing VM:
- Expand a selected virtual disk.
- Move the VM storage directory.
- Change the virtual switch connected to a selected VM network adapter.

Disk and storage changes require the VM to be Off. Disk resize is expand-only in V3.1.0. Network-only changes may be applied while the VM is running.

## Virtual Switch management

The dedicated Virtual Switch tab displays configured switches with type, physical adapter, management-OS access, connected VM count, and notes. It also provides separate Create and Modify sections. Switch names remain read-only; supported modifications are switch type, physical adapter for External switches, Allow Management OS, and notes.

## Job and audit presentation

Dashboard job history and Audit show a readable operation summary such as Create VM, Modify VM, Create Switch, Modify Switch, VM Action, or Eject ISO with the affected resource. The original long technical Job ID remains available as a secondary reference.

## Future Enterprise provider

The storage interface is intentionally isolated so an Enterprise build can move the data layer to SQL Server while retaining the same API and PowerShell execution layer.
