---
status: partly superseded by ADR-0002
---

# The public MCP has no database and lives in its own repository

_Still stands: no database, and a separate public repository. Superseded by [ADR 0002](0002-the-public-mcp-keeps-no-trips.md): the local trip file, this repository owning the shared code, and the private application depending on the published package._

The trip tools are a private project's MCP server today, backed by Supabase with an emailed-code sign-in. For anyone else that is too much to set up. The public server keeps a trip in a local file on the traveller's computer and has no Supabase code at all; the only way out is a calendar export. Phones cannot run a local MCP server, so it is a desktop tool.

It lives in its own repository because a repository is either public or private as a whole, and the private one also holds a web app, the Supabase store and personal trip data. This repository owns the shared code (schemas, gap rules, merge rules, the privacy guard, the trip store interface and its contract tests), the file store, and the MCP server. The private application depends on the published package and gives it a Supabase store, so there is one copy of the rules.

The cost is a publish step before the private application sees a change to shared code. Reversing this means merging two repositories back together, or opening the private one, which is why it is recorded.
