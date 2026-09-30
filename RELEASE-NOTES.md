# Hyper-V Web Provisioning Studio v3.1.0 Professional

## Release highlights

V3.1.0 extends the V3 Professional management layer with VM modification, dedicated virtual-switch management, and more readable job/audit presentation while retaining the validated V2.9/V3.0 Hyper-V workflow.

### Added
- Virtual Machines → Modify: expand virtual disks, move VM storage directory, and change a VM network adapter’s virtual switch.
- Dedicated Virtual Switch tab with switch inventory, connected-VM count, physical adapter binding, management-OS setting, notes, create, and modify operations.
- Readable job summaries in Dashboard history and Audit, with the original long technical Job ID retained as a secondary reference.
- Human-readable job detail panel for audit and job-history entries.
- Operator role permissions for VM modification and switch modification.

### Safety behavior
- Disk resize is expand-only in this release.
- Disk resize and VM storage moves require the VM to be Off.
- Network switch changes can be performed without requiring the VM to be Off.
- Changing a virtual-switch type or physical adapter can affect connected VMs and host connectivity and is presented with an explicit warning in the UI.
- Virtual-switch names are not renamed by the modify workflow.

### Changed
- Provision VM no longer contains a Create virtual switch action. Virtual switches are managed from the dedicated Virtual Switch tab.

### Preserved
- Existing Hyper-V PowerShell engine.
- Local and remote host support.
- Hostname/IP target entry.
- WinRM Negotiate authentication and HTTP/certificate-validated HTTPS selection.
- VM inventory, details, and native VMConnect console.
- vSwitch creation and inventory.
- ISO/VHDX provisioning.
- Secure Boot/vTPM.
- First-power-on ISO boot workflow.
- Manual ISO eject; automatic ISO eject remains removed.
- VM remains Off after provisioning.
- TurnOff terminology.
- Browser/CMD lifecycle shutdown.
- Existing LinkSpeed formatting expression.
- Templates, policies, RBAC, persistent job history, audit integrity, export, backup, dashboard, and embedded management store.

## Distribution

V3.1.0 is delivered as a portable ZIP for development/lab validation. The included WiX source remains a template for a future signed MSI production build.
