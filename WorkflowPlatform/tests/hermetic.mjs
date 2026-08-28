// A test run must not inherit an installation. Every path in the platform follows from a handful of
// variables, and a shell that exported them for one installation hands them to anything started from it:
// the suite then reads another machine's configuration, generates against another project's package
// definitions and reports green on material that is not in this repository at all. Removing them here
// makes the suite mean the same thing on a developer machine and in CI.
for (const name of ["WORKFLOW_PLATFORM_CONFIG", "WORKFLOW_PLATFORM_DATA", "WORKFLOW_PROJECT", "WORKFLOW_ID", "WORKFLOW_DB", "WORKFLOW_TEMP", "ZODCHI_PACKAGE_DEFINITIONS", "AGENT_GATEWAY_ROOT", "AGENT_GATEWAY_ENTRY", "AGENT_GATEWAY_POLICY", "AGENT_GATEWAY_DB"]) delete process.env[name];
