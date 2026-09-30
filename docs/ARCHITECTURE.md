# V3 Professional Architecture

```text
Browser
  |
  | REST + SSE
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

The embedded store is deliberately independent from Hyper-V execution. Hyper-V state remains authoritative on the target host; the store holds management metadata, history, templates, policies, and audit records.
