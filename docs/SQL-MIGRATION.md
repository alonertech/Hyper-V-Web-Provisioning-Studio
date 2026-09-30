# SQL Enterprise Migration Plan

V3 Professional uses an embedded store so customers do not need SQL Server.

The application data model is intentionally relational in shape and can map to SQL Server tables later:

```text
Users
Roles
Hosts
Templates
Policies
Jobs
AuditEvents
Settings
Migrations
```

A future Enterprise adapter can implement the same CRUD operations currently provided by `server/database.js` while keeping the Hyper-V PowerShell layer unchanged.
