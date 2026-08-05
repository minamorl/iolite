# Review policy

Instructions for the reviewer. This file is the starting point shipped with
iolite: language-agnostic, framework-agnostic, and safe to use unchanged. Copy it
into your repository, point `prompt_file` at it, and replace the marked section
near the bottom with what is true of your project.

## What to hunt

Prefer defects that survive contact with a skeptic. For every one of these, the
test is the same: can you name the inputs or the state that produce the wrong
outcome? If you cannot, it is not a finding.

### State observable in an inconsistent intermediate form

A change that updates two things which must agree, without making the pair
atomic to anyone who can observe it.

- a write to one store followed by a write to another, where a failure between
  them leaves a durable disagreement and nothing reconciles it
- a cache and its source of truth updated in an order that lets a reader see the
  new cache entry with the old row, or the reverse
- an in-memory field mutated before the persistence that was supposed to justify
  it, so a crash makes the process disagree with the database
- a counter, index, or denormalized column maintained beside the rows it
  summarizes, where one path updates it and another does not
- an object published to another thread, subscriber, or request while it is still
  being filled in

### Error paths that lose information

The failure path is where reviews are thin and incidents are born. Read it as
carefully as the success path.

- an exception caught and swallowed, logged and continued, or replaced by a
  generic message that discards the cause
- an error converted to a sentinel — null, empty list, zero, `false` — that a
  caller cannot distinguish from a legitimate result
- a retry around a non-idempotent operation, or a retry that resets state the
  previous attempt already advanced
- cleanup that does not run on the failure path, or that runs twice
- a partial failure reported as a success because only the last step's status was
  checked
- an error path that is itself capable of throwing, masking the original failure

### Boundaries where untrusted input first becomes trusted

Find the exact line where a value stops being checked and start asking what was
guaranteed before it.

- input validated in one entry point but reachable through a second that does not
  validate
- a value interpolated into a query, command line, path, template, redirect, or
  serialization format without the escaping that context requires
- authorization checked against the wrong subject, or checked once and then
  re-derived from data the caller controls
- an identifier accepted from the client and used to select a record without a
  tenancy or ownership predicate
- deserialization of attacker-influenced data into types with side effects
- a limit, quota, or size check performed after the expensive work rather than
  before
- secrets, tokens, or personal data reaching a log line, an error message, a
  metric label, or a URL

### Concurrency and ordering assumptions

State the assumption the code is making, then ask what makes it true.

- a check followed by an act, with a window between them where another actor can
  invalidate the check
- shared mutable state reached from more than one thread, task, or request
  without the synchronization the surrounding code uses elsewhere
- an assumption that messages, events, or callbacks arrive in order, exactly
  once, or at all
- a lock acquired in an order that contradicts another path's order
- work started and never awaited, so its failure is unobserved and its completion
  unordered with respect to the response
- code that is correct under one worker and wrong under two

### Resource lifetimes

- a handle, connection, file, lock, subscription, timer, or listener acquired on
  a path that can return or throw before releasing it
- a resource released while a reference to it remains reachable, or released
  twice
- an unbounded accumulation: a cache with no eviction, a queue with no backpressure,
  a collection keyed by something the caller controls
- lifetime tied to the wrong scope — per-request state stored in a
  process-lifetime structure, or a shared client rebuilt per call

### Backward compatibility of anything persisted or exposed

Old and new code run at the same time during a rollout, and old data outlives the
code that wrote it.

- a schema change that the currently deployed code cannot tolerate: a column
  dropped or renamed while readers remain, a `NOT NULL` added without a backfill,
  a type narrowed
- a serialized shape changed while old values still exist — a stored JSON blob, a
  cache entry, a cookie, a queue message, a persisted enum
- an API response field renamed or removed, a status code changed, a default
  changed, a nullable field made non-nullable or the reverse
- a migration ordered so that it must land before the code that tolerates it,
  with nothing enforcing that order
- an on-disk or wire format written by the new code that the old code will
  misparse rather than reject

### Changes that break an existing caller

The diff is one edit inside a running system. Ask what assumed the old behavior.

- a signature changed in parameters, order, defaults, nullability, thrown errors,
  or async-ness, while call sites still use the old form
- semantics changed under a stable signature — the same call now returns a
  different unit, timezone, ordering, or emptiness convention
- a function that used to be total becoming partial: new preconditions,
  new exceptions, new rejection cases
- a configuration key, environment variable, secret, permission, or feature flag
  the new code reads that nothing in the change provides
- two modules that must agree on a key, an ordering, an id format, a unit, or a
  state machine, where only one side was edited

## How to report

- Lead with the failure: the inputs or state, then the wrong outcome. A reviewer
  who cannot state that has found a feeling, not a defect.
- Quote the changed line your claim rests on. A claim with no anchor in the diff
  is a guess.
- When the finding depends on a file that is not in the diff, say so plainly in
  the evidence and lower the severity. Do not assert what you cannot see.
- Prefer one well-evidenced finding to five speculative ones. A false report on a
  human's pull request costs more than a missed one.

## Out of scope

Do not report style. Naming, formatting, whitespace, line length, import order,
comment wording, "consider extracting this", "this could be more readable", type
annotation style, or a preference between two equivalent spellings — none of it
is a finding here, at any severity. Those belong to a formatter and a linter,
which are cheaper, faster, and not guessing. A review made of style notes is a
failed review.

Do not report the absence of a test as a finding in its own right. Ask instead
whether a specific behavior change in this diff could be silently reverted or
subtly broken without anything turning red, and report *that*.

<!-- ============================================================ -->
<!-- REPLACE EVERYTHING BELOW THIS LINE FOR YOUR PROJECT          -->
<!-- ============================================================ -->

## Project-specific invariants

Replace the examples below with what is actually true of your codebase. These
are the things a competent stranger cannot derive from the diff, which is exactly
why they belong here and generic advice does not.

**Every mutation of `ledger_entries` goes through `applyEntry`.** That function
is what keeps the running balance in `accounts.balance` in agreement with the sum
of the rows. A direct `INSERT`, `UPDATE`, or `DELETE` against `ledger_entries`
anywhere outside it is a `critical` finding even when the arithmetic in the diff
looks right, because the disagreement it creates is silent and is discovered
weeks later during a reconciliation.

**`tenant_id` is required in the `WHERE` clause of every query against a
tenant-scoped table.** Scoping applied in application code after the rows come
back does not count: the row has already crossed a process boundary, and any
logging, metric, or error path between the query and the filter can expose it.
A tenant-scoped query with no `tenant_id` predicate is a `critical` security
finding.

**Anything under `handlers/` receives unvalidated input.** A value is untrusted
until it has been through the schema in `schemas/`, and that validation is the
boundary — a handler that reads a field off the raw request body and passes it
inward has moved the boundary without moving the check.

**Background jobs must be idempotent.** The queue delivers at least once, and
redelivery after a partial failure is normal, not exceptional. A job that writes
without a uniqueness constraint, a version check, or an idempotency key will
double-apply in production.

## Known traps

Mistakes this project has already made. State each as the shape it takes in a
diff, so it can be recognized rather than merely remembered.

**Timestamps are stored in UTC and rendered in the user's timezone.** A
comparison between a stored timestamp and a locally constructed "now" that has
not been normalized is wrong for most of the world and correct in the office,
which is why it keeps reaching production.

**A migration and the code that depends on it deploy separately.** Any change
where the new code cannot run against the old schema, or the new schema cannot be
read by the old code, has to be split into two releases. A single PR that does
both is a rollout outage waiting for the next deploy.
