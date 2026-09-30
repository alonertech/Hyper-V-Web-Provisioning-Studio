# Development Notes

## Source tree

This repository is the editable source distribution. It does not include the bundled portable Node runtime or installed npm dependencies.

For development on Windows:

```powershell
npm ci
npm start
```

## Offline operation

The production/lab ZIP published as a GitHub Release is self-contained and includes the bundled Node runtime and dependencies. That package is the preferred choice for Internet-isolated environments.

The source repository itself may require Internet access during initial dependency installation unless dependencies are supplied from an internal package mirror/cache.

## PowerShell

The application uses fixed PowerShell scripts as the Hyper-V execution layer. Changes to provisioning, switch management, VM modification, authentication, target handling or first-boot behavior should be accompanied by validation updates.
