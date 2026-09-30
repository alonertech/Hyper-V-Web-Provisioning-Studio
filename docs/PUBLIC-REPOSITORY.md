# Public Repository Guidance

## Repository vs Release

The GitHub repository is the development/source distribution.

The tested portable package should be published as a **GitHub Release asset** rather than committed into the normal source history.

Recommended release assets:

```text
HyperV-Web-V3.1.0-Professional.zip
HyperV-Web-V3.1.0-Professional.sha256
```

The portable ZIP contains the bundled Node runtime and `node_modules` required for the self-contained lab/offline package. The repository intentionally excludes those generated/vendor-heavy runtime files.

## Public-repository hygiene

Before every public push/release, review:

```text
ProgramData/HyperV-Web-V3/
*.jsonl
*.json
*.clixml
*.pfx
*.p12
*.pem
*.key
*.cer
*.crt
*.log
```

Only generic configuration and documentation should be committed. Runtime management data belongs on the deployment machine, not in source control.

## Suggested GitHub setup

- Keep `main` stable.
- Use Issues for reproducible bugs.
- Use Discussions for architecture/design feedback.
- Use pull requests for code changes.
- Use Releases for tested ZIP builds.
- Enable Dependabot/dependency review as appropriate.
- Enable secret scanning and push protection when available.
