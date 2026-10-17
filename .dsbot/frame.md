# FRAME: plan-preview-copy — v1 — 2026-10-17

## 0. Request (verbatim)
"Add a Copy button to the plan preview."

## 1. Readings (max 3) — what the user might mean
- A. One-click verbatim export of the plan's own source text, with honest success and failure feedback, living inside the plan surface that already exists.
- B. A general "copy this document" affordance for every document surface, of which the plan is only the first.
- C. A trust-preserving copy path: never claim success without a confirmed write, and inherit the existing failure wording rather than inventing new language.
Default if unanswered: A + C

## 2. Actors (max 5)
- User (writes: clicks copy; reads: confirmation or failure text)
- Plan preview surface (reads: the plan source text currently displayed)
- Replacement viewer tab type (writes: the copy control and its states; moderates: which viewer is mounted)
- Host docking system (controls: the panel's top-right chrome; reads: the registered tab type)
- Builtin plan viewer (reads: fallback path; supplies its own failure wording)

## 3. Decisions for the USER (max 5, each with a default and a consequence)
| ID | Question | Default | If you pick the other way |
|----|----------|---------|---------------------------|
| D1 | When the panel shows a review preview rather than a live plan, does copy take the revision being previewed or the current live plan? | The exact source text currently rendered in the panel, even if that revision is not the live plan. | Copy would silently cross revisions; the user could paste content that no longer matches what they are reading. |
| D2 | For an expired preview, does the copy control stay visible and active? | Stays visible and active; it copies what is displayed, relying on the panel's existing expiry chrome for the warning. | Hiding or disabling it removes a path users may still want, but prevents pasting content that is already stale. |
| D3 | Should the copied text include a title or heading line? | No title, no heading, no front matter — source text only. | Pasted text gains context but no longer matches the plan byte for byte. |
| D4 | If the user has a text selection inside the plan and clicks copy, what is copied? | The whole plan always; the selection is ignored. | Selection-scoped copy is more precise but makes the button's behaviour depend on invisible state. |
| D5 | Repeated clicks inside the 1.2 s confirmation window? | Each click writes again and restarts the confirmation window. | Ignoring repeats avoids duplicate clipboard writes but makes the button feel unresponsive on a fast second click. |

## 4. Capabilities needed (verb-noun, NO product names)
- C1 Render a replacement viewer for the existing plan kind, bot mode only, registered as an extension tab type and mounted into the panel's top-right chrome region; the builtin viewer returns when the extension unloads.
- C2 Read the displayed plan's source text verbatim from the host, without re-serializing, re-rendering or normalizing it.
- C3 Write arbitrary text to the system clipboard and receive an explicit success or rejection result for every attempt.
- C4 Show a transient confirmation state for 1.2 s that a later action can replace or cancel, including after the surface unmounts.
- C5 Show the builtin viewer's own failure wording when the source text cannot be read, and never show a success state in that case.
- C6 Keep every visual state within existing design tokens: no new colors, no new motion curves, no new dependencies, no new settings or preference toggles.

## 5. Risky assumptions (max 5, ranked by impact x uncertainty, each with an A id)
| ID | Assumption | Why risky | How to test cheaply |
|----|-----------|-----------|---------------------|
| A1 | Registering an extension tab type for the existing plan kind is enough to take over that panel in bot mode, with no host change. | If the top-right corner has no extension seat, the whole approach is a host feature, not a plugin change. | Register a stub tab type and confirm it mounts in bot mode only. |
| A2 | The plan's source text is reachable verbatim from an extension surface, not only as rendered output. | Verbatim is the core requirement; a rendered-only source forces re-serialization and breaks the copy contract. | Read the plan from the extension and diff it against the builtin viewer's source. |
| A3 | A rejected clipboard write is observable as an error rather than failing silently. | A silent rejection turns the confirmation state into a lie, which the request forbids. | Deny the permission and confirm an error path is reached. |
| A4 | Unloading the extension restores the builtin viewer without a reload or a blank panel. | The stated fallback path is the safety net for the takeover. | Load, unload, and check the panel returns to the builtin viewer. |
| A5 | Existing design tokens already cover default, hover, pressed, success and failure states of the control. | "No new colors" is only satisfiable if the states already exist in the token set. | Map each state to an existing token before building. |

## 6. Research questions for Scout (max 6, each tied to a capability)
| ID | For | Question | Constraints (from D*) | Answered when |
|----|-----|----------|-----------------------|---------------|
| Q1 | C1 | What is the registration contract for an extension tab type that replaces a builtin viewer for one kind in one mode only — required fields, scope, precedence, and unload behaviour? | Mode-scoped takeover only; builtin is the fallback (D1, D2 do not widen scope) | The contract is enumerated, with precedence and fallback behaviour stated |
| Q2 | C1 | Which insertion point does the panel expose in its top-right region, and can an extension render there without adding host chrome? | No new chrome, no new colors, no new settings | A documented insertion point and its layout constraints are named |
| Q3 | C2 | How is the currently displayed plan's source text exposed to a replacement viewer, including for review previews and expired previews, and how stale can it be? | Verbatim only; what is displayed is what is copied | The exact read path and its staleness semantics are documented |
| Q4 | C3 | What clipboard-write path exists in this host runtime, and how does it report rejection — permission denial, insecure context, unfocused document, empty payload? | Never claim success without a confirmed write | Each failure mode and its observable signal is listed |
| Q5 | C4 | Which existing timing and motion primitives already support a 1.2 s transient label change that respects reduced-motion settings? | Reuse existing tokens and springs; no new motion | The existing primitive is identified, or "build from an existing timer plus tokens" is confirmed |
| Q6 | C5 | What is the builtin viewer's own failure text for an unreadable plan, verbatim, and what conditions trigger it? | Reuse that wording; no new copy | The exact string and trigger conditions are quoted from source |

## 7. Roles needed
- Architect: yes — the takeover boundary (mode scope, fallback, source-text read path) is the whole design risk.
- Builder: 1 — one surface, one control, one read path.
- Reviewer: yes — verbatim copy and the never-lie failure state need a second pair of eyes.
- Tester: yes — takeover, unload fallback, denied clipboard, preview and expired states.
- Not needed: none — the surface is small enough that no role is dead weight.

## 8. What could go wrong (max 5, each with a K id)
- K1 A clipboard write can resolve while nothing lands (focus loss, pending permission), so "Copied" could still be false.
- K2 The takeover is mode-scoped; a missed scope check silently replaces the plan viewer everywhere.
- K3 Copying a review preview verbatim can paste a revision the user believes is the live plan.
- K4 The 1.2 s timer can outlive its surface (unmount, plan switch) and fire into a gone component.
- K5 Extension unload during a copy or a failure leaves the panel blank until the builtin remounts.

## 9. The user may not have considered (max 3)
- The clipboard is readable by other apps and clipboard history; a plan can contain sensitive content.
- A label swap is not an announcement: keyboard and screen-reader users need the confirmation conveyed, not just drawn.
- Two plan panels, or a plan switch inside the 1.2 s window, can show a confirmation on the wrong plan.

## 10. Parking lot (ignored downstream)
- Copy as link or shareable reference instead of plain text.
- Selection-scoped copy as a second affordance.
- The same copy control on other document surfaces.

## 11. Out of scope (explicit)
- Changing or restyling the builtin plan viewer.
- New settings, preferences or toggles.
- New dependencies, new colors, new motion curves.
- Other document kinds, and any mode other than bot mode.

Standards: WCAG 2.2 AA for the status announcement and focus visibility
