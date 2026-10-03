# ADR-0023 — The directory is a contact list. Departments stop being something you pick.

**Status:** Accepted · 2026-08-22
**Decided by:** the project owner, on the district's own account of using the picker.
**Amends:** [ADR-0010](./ADR-0010-two-rung-ladder.md) — its derivation of a seat's tier from the
department, which is now reachable only by seats that will not exist.
**Rests on:** [ADR-0004](./ADR-0004-authority-attaches-to-the-post.md) — *authority attaches to the
post, knowledge attaches to the person*. That rule is what makes this safe rather than a loss: the
designation **is** the post, and it stays.
**Follows:** [ADR-0018](./ADR-0018-control-room-only.md) and
[ADR-0022](./ADR-0022-the-control-room-assigns.md), whose removal pattern this copies exactly.

---

## Context

The district asked for the recipient picker to be *"as simple as adding a contact on a phone"* —
name, designation, phone — and said plainly why:

> *"Jab koi report darj karta hai to who should know wale tab mein names bhi aa jate hain aur
> department bhi aa jate hain, jis se bahut confusion ho jati hai."*

That reads as a complaint about a screen. **It is not.** It was checked against Bajaur's own
directory rather than reasoned about:

| | |
|---|---|
| Departments the picker listed | **79** |
| Posts the picker listed | **81** |
| Named people the picker listed | **40** |
| **Total selectable rows** | **200** |
| **Actual reachable handsets** | **40** |

**Five rows for every one human being.** One officer appeared three times — as a department
(`Assistant Commissioner Bajaur`), as a post (`AC HQ Bajaur`) and as a person (`Officer Juliet`) —
all three the same number.

And the layer producing it is not there. **79 departments for 81 posts**: almost every one holds a
single person and its name restates the designation — `ADC (General)` over `ADC (G) Bajaur`,
`Deputy Commissioner Office` over `Deputy Commissioner`. In the whole district **only two**
departments hold more than one person (Irrigation, WSSC Bajaur). The other 77 are shells.

**Bajaur is a flat list of about 81 posts.** The hierarchy was this software's assumption about how
a district is organised, and it was wrong about this one.

### Why it worked anyway, and why nobody could say what was wrong

`collapseSelection` has absorbed the overlap **at send time** since M6 — a post into its
department, a person into a post they hold — so three ticks always produced one message. The mess
was at *selection* and the fix was at *dispatch*. That is exactly why the picker had always looked
wrong and behaved correctly, and why the complaint took until August to arrive in words.

---

## Decision

**One row per contact.** A contact is a **post and whoever holds it**: `seat.title` is the
designation, the current holder is the name, their `phone` is the number. No new table and no
migration — the three fields the district asked for were already stored.

**`department` and `person` are no longer offered as things to pick.** They are not filtered by
reachability; the kinds are not returned by `listRecipients` at all.

**A vacant post stays in the list, marked.** A phone's contact list has no such idea, and 38 of
Bajaur's 81 posts have nobody in them. This is where somebody notices — `assertOfferedAnyway` and
ADR-0005: a vacancy nobody can see is a vacancy nobody fills, and a vacant post that quietly
swallows an obligation produces silence, which reads as *everybody was told*.

**Groups become the way many people are told**, which is the district's own argument and it is
correct:

> *"Group mein mukhtalif department ke log add ho sakte hain, department mein nahi."*

A department can only ever hold its own people. A group holds whoever the control room says — an
AC, a XEN, a Rescue officer and a Tehsildar in one list, because that is who turns up to a flood.
Groups already existed, were already restricted to the two offices, and already copy their members
onto the incident rather than referencing them. Nothing about them had to be built.

**The record is not touched.** `department` and `person` targets are all over the event log and
stay readable for ever (ADR-0001). This is the same road ADR-0018 and ADR-0022 built:

| | Removed | Kept |
|---|---|---|
| ADR-0018 | the in-app inbox | `NotifyChannel: 'web'` in the type; nothing writes it |
| ADR-0022 | routing signals | `ruleId: 'auto'`, `signalIds` in the type; nothing writes them |
| **ADR-0023** | **department and person as things to pick** | **both kinds in the type and in the log; `listDirectory` still names them** |

---

## What this forced, and both were faults rather than tidying

### 1. Two designations held by one officer are now one message

Nothing ever collapsed **post against post**. It stayed harmless only while the person row existed
to absorb the overlap, and while ticking two designations held by one officer was an odd thing to
do on a picker grouped by department.

It is the obvious thing to do on a flat list. **Officer Delta** holds *C&W Buildings* and *C&W Highways*;
**Officer Charlie** holds *ADC General* and *ADC Relief* — in the original deployment's directory
(M10-05). Uncollapsed, that is two obligations and **two messages to one handset for one
emergency**, which `domain/recipients.ts` calls the fastest way to teach somebody to mute their
phone.

`collapseSelection` now absorbs the second designation into the first, and **records what covered
it**. *"Tell Highways"* was really said, and *"was Highways told?"* has to answer yes.

### 2. 🔴 A proposal this screen cannot draw is dropped, never ticked invisibly

`learning.ts` proposes out of the district's own dispatch history, and **every dispatch made before
today is department-kinded**. A department has no row any more. So opening the picker would have
pre-ticked a department nobody could see — a target that is **ticked and not drawn**, which sends,
records, and shows no tick anybody could have disagreed with. This project's worst signature: *the
action succeeds*.

**This was not one table row away. It was already true of the live installation** the morning the
flat directory would have shipped, because Bajaur has months of department-kinded history. M10-09
named this fault; the flat directory opened a new door to it within hours.

Proposals are now filtered against what the directory can actually draw. New history is
post-kinded, so it drains by itself.

### 3. The add-an-officer door broke, and the test caught it

The form read its department options out of the recipient list. With no department rows the select
came back empty and **nobody could be added at all** (M9-23's whole purpose). Placement is now its
own field on the reply — `departments`, kept deliberately apart from `recipients`, because one is
where a person is *filed* and the other is who may be *told*. Merging them is how a department
finds its way back onto the screen the district asked to have it taken off.

---

## Consequences

**What the district gets:** about 40 rows instead of 200; one row per officer, carrying the name,
the designation and the number; search that works on any of the three.

**What comes off the screen:** *"Tell all N"* (M9-20). It was safe while it meant *this
department's officers*; on one flat list the same code means **"Tell all 40"** — the whole district
in a click, beside the checkbox somebody is aiming for at 02:00. Groups are the replacement and are
better: a named set somebody chose.

**What is deferred, and is not done by this ADR:**

* `is_administration` is still derived from the department. It must become an explicit flag on a
  contact. ⚠️ **It must never be read out of the designation text** — the district's rule *"agar AC
  HQ likha hai to pata chal gaya"* is right for a human reading the screen and wrong for software:
  a typo, a rename or an *"AC HQ (acting)"* would silently grant or remove the right to issue a
  district advisory, and nothing on any screen would show it.
* The authority table still names a department as the owner of an incident's fields.
* Adding an officer still asks which department to file them in.
* *Open by department* and *Response times per department* still exist as panels.

**What is not lost:** every past record; ADR-0004's rule; groups; and the ability to bring
departments back if Bajaur ever reorganises into real ones. A door left closed, not welded.
