Step: {{step}} (code-package v1, run {{run}})

Review one finished change: an independent review; you did not write it. The change is the package described in
the attached brief (attachment "brief"); its diff against the base commit {{base}} is attached as "change.diff".

What the change does, from its writer: {{summary}}
What the writer could not verify: {{unverified}}
How the engine verified it: {{verification}}
{{history}}
{{focus}}

Every finding has a severity: "important" (a real defect the change brings in; it blocks approval), "nit" (worth
fixing, does not block) or "pre-existing" (it was there before the change; does not block). verdict "approved"
only when no important finding is open; "blocked" when the change cannot be judged from what the request holds.
