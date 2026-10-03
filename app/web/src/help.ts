/**
 * "How to use" — an in-product guide, for the operator rather than the engineer.
 *
 * This exists because the product itself is the only place a non-technical reader will ever
 * look. A guide that lives in a repository, or as a document somebody was emailed once, is a
 * guide that goes stale the moment a screen changes and nobody notices — the same failure this
 * project has named five times over in `CLAUDE.md`: *a document that outlives the decision it
 * was written under is worse than none*. Keeping it inside the application does not fix that by
 * itself, but it puts the guide where whoever changes a screen is most likely to see it needs
 * changing too.
 *
 * **Static, and deliberately so.** Nothing here calls the server. It is fetched once (like
 * `report.js` and `search.js`) and after that works with no connection at all — an operator can
 * read it standing at a scene with no signal, which is exactly when a screen's purpose is least
 * obvious.
 *
 * **The content mirrors the actual navigation**, chapter for chapter — Report, Who should
 * know / Who was told, Record, Dashboard, Administration, Reports, the rest — rather than
 * inventing its own structure. Somebody looking for help with a screen finds it under that
 * screen's own name.
 *
 * Not capability-gated (`domain/capabilities.ts`). It is documentation about the product, not a
 * part of it, so it stays visible to anyone signed in whatever this installation currently
 * offers — turning a screen off does not make the paragraph explaining it disappear, and an
 * administrator deciding what to turn *on* needs to be able to read what a capability does.
 */

export interface HelpPanel {
  show(): void;
}

const CONTENT = `
  <p class="lede">What each screen is for, and what happens when you use it — written for
  whoever is running the control room, and for the officers who post their work in
  Activities, not for whoever built it.</p>

  <ul class="jump">
    <li><a href="#help-overview">Overview</a></li>
    <li><a href="#help-signin">Signing in</a></li>
    <li><a href="#help-activities">Activities</a></li>
    <li><a href="#help-report">Report screen</a></li>
    <li><a href="#help-whotell">Who should know</a></li>
    <li><a href="#help-communications">Meetings and notices</a></li>
    <li><a href="#help-lifecycle">What the officer can do from the message</a></li>
    <li><a href="#help-correct">Correcting something sent in error</a></li>
    <li><a href="#help-board">Record</a></li>
    <li><a href="#help-dashboard">Dashboard</a></li>
    <li><a href="#help-admin">Administration</a></li>
    <li><a href="#help-settings">Settings</a></li>
    <li><a href="#help-reports">Reports</a></li>
    <li><a href="#help-daily">The daily report</a></li>
    <li><a href="#help-other">Other screens</a></li>
    <li><a href="#help-whatsapp">WhatsApp — today and once it is live</a></li>
    <li><a href="#help-language">Urdu, and installing the app</a></li>
    <li><a href="#help-glossary">Glossary</a></li>
  </ul>

  <section class="hchapter" id="help-overview">
    <p class="heyebrow">Overview</p>
    <h2>What this system is for</h2>
    <p>This is Bajaur district's record of what happens — emergencies first, and the district's
    day-to-day condition alongside them. What used to be written by hand in a register and
    forwarded by phone now goes through one place, and nothing in it is ever deleted.</p>
    <p>The rule behind every screen is the same one: <b>an emergency, reported anywhere, must
    reach the right person, stay visible until somebody answers, and never go quiet just
    because a device is switched off.</b> The nine steps below are that rule, end to end.</p>

    <h3>One emergency, start to finish</h3>
    <ol class="hjourney">
      <li><b>It is reported</b><p>A call reaches the control room and an operator writes it on
        the <kbd class="uilabel">Report emergency</kbd> screen — or an officer at a scene reports
        it on their own phone, where that path is turned on.</p></li>
      <li><b>It is saved immediately, signal or no signal</b><p>With no connection, the report
        stays on the device it was entered on and sends itself the moment one returns. Nothing
        is ever refused for being incomplete.</p></li>
      <li><b>Duplicate reports become one incident</b><p>Five calls about the same accident join
        into a single record rather than five separate ones.</p></li>
      <li><b>The operator decides who should know</b><p>On the <kbd class="uilabel">Who should
        know?</kbd> panel, a department, a designation, or a named officer is ticked. The system
        proposes a starting point, based on who has usually been told about this kind of thing
        before.</p></li>
      <li><b>They are told</b><p>Today, <kbd class="uilabel">Reach them</kbd> opens the number.
        Once the district's WhatsApp account is live, the same tick sends the message itself —
        see the WhatsApp chapter.</p></li>
      <li><b>The answer is recorded</b><p>Either they confirm it themselves, or the operator
        records what was said on the phone. <b>The two are never added together</b> — one is
        something the system observed, the other is the operator's own account of a call.</p></li>
      <li><b>If nobody answers, it escalates on its own</b><p>The server keeps the clock, not a
        person, so it works even if every phone in the district is switched off.</p></li>
      <li><b>The response is recorded as it happens</b><p>Teams, vehicles, actions taken — all
        attached to the same incident.</p></li>
      <li><b>It is closed, with the full history intact</b><p>Every step remains readable months
        later. Nothing here can be quietly edited.</p></li>
    </ol>

    <div class="note"><b>Worth knowing:</b> only the control room works an emergency in this
    system. Officers are in the Directory so they can be told, and they answer from the WhatsApp
    message itself — no login is needed for that. An officer may also be given a login of their
    own, but it opens <b>Activities only</b>: the control room's screens stay closed to it.</div>
  </section>

  <section class="hchapter" id="help-signin">
    <p class="heyebrow">Signing in</p>
    <h2>Signing in</h2>
    <p>The address opens a short form — a phone number and a password, nothing else.</p>
    <div class="hscreen">
      <div class="hbar" translate="no">dnc.example.com</div>
      <div class="hbody">
        <div class="htiles"><span class="htile">Phone number: 03XXXXXXXXX</span></div>
        <div class="htiles"><span class="htile">Password: ••••••••••</span></div>
        <span class="hbtn primary">Sign in</span>
      </div>
    </div>
    <p><b>The phone number is the username</b> — there is no separate name or email to
    remember. What you can see is decided by the role your account was given, and it is worked
    out fresh every time you sign in.</p>
    <div class="htwrap">
      <table class="htable">
        <tr><th>Role</th><th>What it opens</th></tr>
        <tr><td>owner, admin</td><td>Every screen, Settings included.</td></tr>
        <tr><td>operator</td><td>The control room's screens — reporting, telling people, the
          Record.</td></tr>
        <tr><td>viewer</td><td>The same screens, to read only. Anything that would change the
          record is refused.</td></tr>
        <tr><td>member</td><td>Activities only. This is the login an officer is given.</td></tr>
      </table>
    </div>

    <h3>A new login arrives as a link</h3>
    <p>When somebody is given a login, they are sent <b>a sign-in link</b>. Opening it asks them
    to choose their own password, and signs them in. The link <b>works once and lasts 3
    days</b>. Until the district's WhatsApp message for it is approved, whoever gave the login is
    shown the link with a <kbd class="uilabel">Copy</kbd> button, to send by hand.</p>
    <p><b>Forgotten your password?</b> Ask the control room. <kbd class="uilabel">Send sign-in
    link</kbd> on the Officers tab of Activities sends a fresh link; the old password stops
    working when the new one is chosen.</p>
    <div class="note warn"><b>Repeated wrong passwords slow down, they do not lock out.</b> Each
    wrong attempt adds a short delay rather than blocking the account — enough to stop someone
    guessing, without ever being able to shut a real officer out on a real night.</div>
  </section>

  <section class="hchapter" id="help-activities">
    <p class="heyebrow">Activities</p>
    <h2>The district's daily work, in pictures</h2>
    <p>Activities is where officers show what was done that day — a visit, an inspection, a
    meeting — with photos, videos or a voice note. <b>It is separate from emergencies.</b>
    Nothing posted here raises an alarm, starts a clock or reaches the Record.</p>
    <div class="hscreen">
      <div class="hbar">Activities · Bajaur</div>
      <div class="hbody">
        <div class="htabs">
          <span class="htab on">Activities</span><span class="htab">New post</span>
          <span class="htab">Pending</span><span class="htab">More</span>
        </div>
      </div>
    </div>
    <p>An officer sees <kbd class="uilabel">Activities</kbd>, <kbd class="uilabel">New
    post</kbd> and <kbd class="uilabel">My account</kbd>. The DC office also has <kbd
    class="uilabel">Pending</kbd> — shown only while something is waiting — and <kbd
    class="uilabel">More</kbd>, which holds <kbd class="uilabel">Officers</kbd>, <kbd
    class="uilabel">History</kbd> and <kbd class="uilabel">My account</kbd>. <b>Every account
    reads every post.</b></p>

    <h3>Reading the posts</h3>
    <p>Activities opens on the posts, newest first. Each one says <b>who sent it</b> — name,
    post, department and mobile number — then what they wrote, then the photos, videos and voice
    notes. <kbd class="uilabel">All</kbd> shows every department. <kbd
    class="uilabel">Departments</kbd> lists each department with how many posts it holds; tap one
    to see only its posts. <kbd class="uilabel">Filter</kbd> narrows by person and date.</p>

    <h3>Seen, Well done and comments</h3>
    <p>Under a post, anybody who can see it can mark it <kbd class="uilabel">Seen</kbd> or <kbd
    class="uilabel">Well done</kbd> — one mark each; tap it again to take it off — and write a
    comment. <b>These stay inside the app.</b> Nothing is sent to the officer on WhatsApp, so an
    officer who posts by WhatsApp and never signs in does not see them.</p>

    <h3>Respond — a message to the officer</h3>
    <p>The DC and the control room have one more button under a post: <kbd
    class="uilabel">Respond</kbd>. It sends your message on WhatsApp, from the district's number,
    <b>only to the person who sent that post</b>. The message says it is from Activities and ends
    <i>This is not an emergency alert</i> — there is no clock and nothing to acknowledge.</p>
    <p>Under the post you then see whether it was <i>Sent</i>, <i>Delivered</i>, <i>Read</i> or
    <i>Not sent</i>, with the reason. When the officer answers — best with WhatsApp's own reply
    on that message — the answer appears under the same post. <b>Only the DC and the control
    room see Respond, the messages and the answers.</b></p>
    <div class="note"><b>WhatsApp allows a free message only within 24 hours of the officer's
    last message to the district's number.</b> After that it needs a message form approved by
    Meta; until that is approved, the screen says that nothing was sent.</div>

    <h3>Posting from the app</h3>
    <p><kbd class="uilabel">New post</kbd> asks for the department, the date of the activity and
    what was done; a place is optional. Add <b>up to 10 photos</b> and <b>up to 3 videos, each
    at most 3 minutes</b>. Photos are made smaller on the phone before they are sent, and a
    video shows as <i>processing</i> until the server has prepared it.</p>
    <p>This part <b>needs a connection</b>. If a photo fails on a weak signal, the post itself is
    already saved — <kbd class="uilabel">Try the failed ones again</kbd> sends only what is
    missing.</p>

    <h3>Posting by WhatsApp, with no login</h3>
    <p>Anybody in the Directory can send a photo, a video or a voice note to the district's
    WhatsApp number, and it becomes a post under their name. The words sent with it become the
    caption. It is filed under their department, or under <b>General</b> when they have
    none.</p>
    <p><b>If an emergency they were told about is still open</b>, the reply asks which it is,
    with two buttons: <kbd class="uilabel">Emergency report</kbd> and <kbd class="uilabel">Daily
    activity</kbd>. With no answer in an hour it goes to the emergency — a picture from a scene
    must never be lost in the daily pictures.</p>
    <div class="note"><b>This works once the district's WhatsApp account is live.</b> Until
    then, posting from the app is the way.</div>

    <h3>Pending</h3>
    <p>What arrived on WhatsApp and needs the DC office — mostly from numbers that are not in the
    Directory. Each one can be approved under somebody already there, deleted, or its number can
    be added with <kbd class="uilabel">Add to Directory</kbd>, after which that number's pictures
    post by themselves. The number on the tab is how many are waiting; with nothing waiting, the
    tab is not shown.</p>
    <div class="note warn"><b>Adding a number to the Directory is more than Activities.</b> A
    Directory contact can be chosen on <kbd class="uilabel">Who should know?</kbd> and sent
    emergency alerts. Add only somebody the district means to reach.</div>

    <h3>Officers</h3>
    <p>Under <kbd class="uilabel">More</kbd>. Every Directory contact and every account, with
    three controls: the <b>department</b>
    their posts are filed under, <b>Activities on or off</b> (off: what they send waits on
    Pending instead of posting), and <kbd class="uilabel">Give login</kbd>, which always gives a
    <i>member</i> login — Activities only. The <b>Department list</b> sits below: add one, or
    retire one and its old posts stay under its name.</p>

    <h3>Posts are kept for 30 days</h3>
    <p>Thirty days after it was uploaded, a post and its photos and videos are deleted — the
    Recycle bin included. Three days before, the DC office is shown what is about to go, with
    <kbd class="uilabel">Download ZIP</kbd> to keep a copy.</p>

    <h3>Removing a post, and History</h3>
    <p>An officer can delete their own post, under <kbd class="uilabel">Options</kbd> on the
    post. There the DC office can <kbd class="uilabel">Move to Recycle bin</kbd> — which hides it
    and can be undone with <kbd class="uilabel">Restore</kbd> — or <kbd class="uilabel">Delete
    permanently</kbd>, which cannot; its comments and messages go with it. <kbd
    class="uilabel">History</kbd>, under <kbd class="uilabel">More</kbd>, opens on the log of who
    posted, hid, restored or deleted what, with the Recycle bin one tap away.</p>
    <div class="note"><b>This is the one place in the system where something can be
    deleted.</b> An emergency's record never can be — see <a href="#help-correct">correcting
    something sent in error</a>.</div>
  </section>

  <section class="hchapter" id="help-report">
    <p class="heyebrow">Report screen</p>
    <h2>The screen you land on</h2>
    <p>Signing in opens straight onto this screen, because it is the one used most.</p>
    <div class="hscreen">
      <div class="hbar">Report emergency</div>
      <div class="hbody">
        <p class="dim" style="margin:0 0 .3rem">What happened</p>
        <div class="htiles">
          <span class="htile on">Fire</span><span class="htile">Road accident</span>
          <span class="htile">Medical</span><span class="htile">Flood</span>
          <span class="htile">Security</span><span class="htile">Other</span>
        </div>
        <p class="dim" style="margin:0 0 .3rem">How serious</p>
        <div class="htiles">
          <span class="htile on">Critical</span><span class="htile">High</span>
          <span class="htile">Moderate</span><span class="htile">Low</span>
        </div>
        <p class="dim" style="margin:0 0 .3rem">Incident details</p>
        <div class="htile" style="width:100%">Two shops on fire, near the bazaar…</div>
        <div style="margin-top:.8rem"><span class="hbtn">Report emergency</span></div>
      </div>
    </div>
    <p><b>Two taps and a button — no typing required</b>, unless you choose to add some. That is
    deliberate: if this took longer than a phone call, people would just make the phone call
    instead.</p>
    <p><kbd class="uilabel">Incident details</kbd> only appears for the control room.
    It is where the operator writes down what the caller actually described — and it matters
    beyond the record itself, because the system searches these words when it proposes a
    department (writing "canal breach" is what lets it suggest Irrigation, for instance).</p>
    <p><kbd class="uilabel">What kind of message is this?</kbd> lets an operator send an
    <i>advisory</i>, <i>alert</i>, or <i>order</i> through the same screen — the same tools,
    just a different word on the officer's phone.</p>
    <p>Pressing the button saves the report at once, with or without a connection. What follows
    — the exact place, more detail, and choosing who should know — comes after, because the
    report is already safe by that point.</p>
  </section>

  <section class="hchapter" id="help-whotell">
    <p class="heyebrow">Who should know</p>
    <h2>Choosing who to tell, and seeing who answered</h2>
    <p>This panel opens right after a report is saved. It is the part of the system that
    replaces what used to happen only on an operator's own phone, with nothing kept of it.</p>

    <h3>Who should know?</h3>
    <div class="hscreen">
      <div class="hbar">Who should know?</div>
      <div class="hbody">
        <div class="hrow"><span translate="no">☑ Rescue 1122</span><span class="why">proposed — told for fire, 9 out of the last 9 times</span></div>
        <div class="hrow"><span translate="no">☑ TMO Bajaur</span><span class="why">matched — the word "bazaar"</span></div>
        <div class="hrow"><span translate="no">☐ Police Station Khar</span><span class="why">vacant designation — nobody currently holds it</span></div>
        <div style="margin-top:.8rem"><span class="hbtn primary">Tell them</span></div>
      </div>
    </div>
    <p>A pre-ticked box is a <b>suggestion, never a decision</b> — it can always be unticked.
    Two things produce a suggestion: a rule set up in advance (a word like "bazaar" pointing at
    Municipality), and what the system has learned from what usually gets sent for this kind of
    emergency. Either way, it always says why.</p>
    <p><b>A vacant designation is shown, not hidden.</b> Hiding it would take away the one chance
    somebody notices it is empty and gets it filled.</p>

    <h3>Telling a whole department at once</h3>
    <p>Each department heading has a <b><kbd class="uilabel">Tell all 8</kbd></b> button. It
    ticks that department's officers <b>visibly</b>, and every one of them can be unticked
    again — you always see exactly who is about to be messaged before anything is sent.</p>
    <p>The button also warns you: <b>"3 of 8 cannot be reached"</b>. Those three are still
    recorded as owed a message, and still show on the Record as unmet. It is a warning, never a
    filter — silence would read as "everybody was told".</p>

    <h3>Somebody missing from the list</h3>
    <p>If you search for an officer and they are not there, <b>add them from this screen</b> —
    you do not have to leave for the console and lose what you were writing. The offer appears
    where the search found nothing, with the name you typed already filled in. Each department
    heading also has <kbd class="uilabel">Add an officer</kbd>.</p>
    <p>The form offers that department's <b>empty designations</b>, so an officer can be put straight
    into one the screen is already reporting as unfilled. Adding somebody with no designation is
    allowed, and the form tells you what that means before you do it.</p>

    <h3>Who was told</h3>
    <div class="hscreen">
      <div class="hbar">Who was told · 17 told · 9 confirmed · 8 silent</div>
      <div class="hbody">
        <div class="hrow"><span>Rescue 1122 — Duty Officer</span><span class="hpill ok">Confirmed</span></div>
        <div class="hrow"><span translate="no">TMO Bajaur</span><span class="hpill wait">Waiting</span></div>
        <div class="hrow"><span>Health Department</span><span class="hpill bad">No answer</span></div>
      </div>
    </div>
    <p>If the operator reached someone by phone, this is where it is recorded — <kbd
    class="uilabel">They confirmed</kbd> or <kbd class="uilabel">No answer</kbd>, followed by
    what was actually said. Nothing saves without those words, because that sentence is the
    entire record of the call.</p>
    <div class="note"><b>One rule worth remembering everywhere in this system:</b> a recipient
    tapping to confirm, and an operator recording a phone call, are kept as two separate kinds
    of answer and are never added together. One is something the system saw happen; the other
    is somebody's own account of a conversation. Both are real — they are just not the same
    kind of real.</div>
  </section>

  <section class="hchapter" id="help-communications">
    <p class="heyebrow">Not every message is an emergency</p>
    <h2>Meetings, schedules and notices</h2>
    <p>The same screen that reports an emergency also sends the district's ordinary messages.
    Choose what kind it is at the top, and <b>the form changes to ask for what that kind
    actually needs</b> — a meeting asks for a subject, a date, a time and a venue; a schedule
    asks what it runs between; a notice asks for a subject and a note.</p>
    <p>The button at the bottom changes with it. It says <b><kbd class="uilabel">Send
    Meeting</kbd></b>, not "Report emergency", so nobody sends a meeting invitation thinking
    they have raised an alarm.</p>

    <div class="note"><b>A meeting notice carries no emergency clock.</b> Emergencies have an
    acknowledgement deadline and an escalation ladder behind them; a meeting does not. That is
    deliberate — escalating a meeting notice at 02:00 teaches everybody to ignore the escalation
    that matters. The notice is still fully recorded, and if it reaches nobody the Record still
    says so.</div>

    <h3>Attaching a file</h3>
    <p>An agenda, a photograph, a scanned order. Choose the file while you are writing, and it
    goes with the message. <b>Report first, attach second</b> — the report is saved the moment
    you press the button, and the file follows. If the upload fails, the file is kept and the
    screen tells you why rather than losing it quietly.</p>
    <p>The officer receives <b>a link</b> in their message. It opens without an account and
    keeps working for two weeks, so a notice sent on Monday still opens at Thursday's meeting.
    <b>PDF and photographs only</b>, and the system checks the file itself rather than trusting
    its name — a document renamed to <code>.pdf</code> is refused.</p>
  </section>

  <section class="hchapter" id="help-lifecycle">
    <p class="heyebrow">One button, the whole story</p>
    <h2>What the officer can do from the message</h2>
    <p>Every emergency now reads as one of <b>three words</b>, on the Record and on the
    incident:</p>
    <ul>
      <li><b>Issued</b> — the district has it; nobody has said they are taking it yet.</li>
      <li><b>Responded</b> — somebody is actually doing something about it.</li>
      <li><b>Resolved</b> — it has ended, and how it ended is written down.</li>
    </ul>
    <p>There used to be a fourth, <b>Acknowledged</b> — a receipt, separate from saying what you
    were doing. It is gone: the buttons on the message are the district's own three real answers
    for that kind of emergency, and tapping one already <em>is</em> the response, so there is
    nothing left for a bare "I have seen this" to mean. The officer moves it through those
    <b>from their own handset, with no account and no login</b>. Where a message instead carries
    a link, tapping it opens a page that offers the same real options — <kbd
    class="uilabel">Mark as responded</kbd> and <kbd class="uilabel">Mark as resolved</kbd>.
    Resolving asks for one line about what happened — a resolution recorded as "resolved"
    answers nothing when the district reads it back.</p>

    <h3>Are you available?</h3>
    <p>The same page asks whether the officer is available: <b>available</b> or
    <b>unavailable</b>, and nothing more. The control room can set it too, by hand, on the
    Status screen — and from there it picks which available officers show on the Dashboard,
    with name and designation.</p>
    <div class="note"><b>Nothing sets this by itself.</b> No timer, no reset — a report stands
    until the control room changes it. There is no "until when": the district asked for that
    to go.</div>
    <p>Each of these links works <b>once</b>. Tapping one a second time says so plainly rather
    than recording it twice, and a link tapped a day later says it is too old rather than
    quietly doing nothing.</p>
  </section>

  <section class="hchapter" id="help-correct">
    <p class="heyebrow">Read this before you need it</p>
    <h2>Correcting something sent in error</h2>
    <p>Every incident has a <b><kbd class="uilabel">Correct this</kbd></b> button. You say what
    was wrong and, if you know it, what is true instead. The correction then sits <b>beside</b>
    the original — on the incident, on the Record, and in the daily report.</p>

    <div class="note"><b>It does not unsend the message, and nothing can.</b> WhatsApp does not
    recall a message that has already been delivered. Everybody who was told still has the
    original on their handset, exactly as it was sent. <b>If it matters, tell them again or ring
    them.</b></div>

    <p>Nothing is deleted, and nothing is crossed out. This system has no way to remove anything
    from its record — that is the reason the record can be trusted in an inquiry — so a mistake
    is answered by adding the truth next to it, with your name and the time on both.</p>
    <p>It works after an incident is closed, too. Most mistakes worth correcting are noticed the
    next morning.</p>
  </section>

  <section class="hchapter" id="help-board">
    <p class="heyebrow">Record</p>
    <h2>Everything the district has ever reported</h2>
    <p>The Record answers a different question from the Dashboard. The Dashboard is
    <b>today</b> and empties at midnight; the Record keeps <b>everything</b> — still open,
    done, and closed — for as long as the district has been running. Nothing is ever deleted
    from it.</p>
    <p>So when something drops off the Dashboard because the day ended, this is where it went.
    It did not disappear.</p>
    <p>However you open the Record, it starts <b>newest first</b> — the most recently entered
    incident at the top, open or already closed — and runs back from there. Pick a day at the
    foot of the screen when you want to read one back.</p>
    <div class="hscreen">
      <div class="hbar">Record</div>
      <div class="hbody">
        <div class="hcounters">
          <div class="hcounter"><b>14</b><span>open</span></div>
          <div class="hcounter bad"><b>5</b><span>issued</span></div>
          <div class="hcounter bad"><b>2</b><span>past deadline</span></div>
          <div class="hcounter"><b>critical</b><span>worst assessed</span></div>
          <div class="hcounter"><b>1</b><span>not yet assessed</span></div>
          <div class="hcounter bad"><b>0</b><span>message failed</span></div>
          <div class="hcounter bad"><b>0</b><span>no one chosen</span></div>
        </div>
      </div>
    </div>
    <p>Every number can be clicked, and doing so filters the list to exactly those emergencies
    — for instance, <kbd class="uilabel">no one chosen</kbd> shows only the ones nobody has been
    told about yet.</p>
    <div class="htwrap">
      <table class="htable">
        <tr><th>Number</th><th>What it means</th></tr>
        <tr><td>open</td><td>Every emergency still in progress</td></tr>
        <tr><td>issued</td><td>It has gone out and nobody has confirmed yet</td></tr>
        <tr><td>past deadline</td><td>The time allowed to answer has run out</td></tr>
        <tr><td>worst assessed</td><td>The most severe rating currently open — kept separate from the count below so a critical is never hidden inside a bigger, calmer number</td></tr>
        <tr><td>not yet assessed</td><td>Severity has not been judged yet</td></tr>
        <tr><td>message failed</td><td>Somebody was owed a message and demonstrably did not get it</td></tr>
        <tr><td>no one chosen</td><td>No recipient was ever chosen — nobody has been told at all</td></tr>
      </table>
    </div>
    <p>Opening any row shows the full incident — everything anyone has done, when, and by whom.
    If a value was ever overridden, the original entry stays visible underneath it rather than
    being replaced.</p>
    <div class="note"><b>The Record always says how old it is.</b> If it has not reached the
    server in the last 30 seconds, it says so in words — so a screen that stops updating during
    an outage never looks like a screen with nothing wrong.</div>
  </section>

  <section class="hchapter" id="help-dashboard">
    <p class="heyebrow">Dashboard</p>
    <h2>The screen meant for a wall or a TV</h2>
    <p>The Dashboard is <b>today</b>, and it is the screen the district is run from — the whole
    day's condition at a glance, on a laptop or an office screen. It empties at midnight, and
    what was still open goes on being visible in the band marked <b>From earlier days</b>
    underneath the district's own numbers.</p>
    <div class="hscreen">
      <div class="hbar">Dashboard</div>
      <div class="hbody">
        <div class="hpanels">
          <div class="hpanel wide"><b>District counters</b>today's numbers, each one clickable</div>
          <div class="hpanel"><b>Emergency situation</b>the state of each kind</div>
          <div class="hpanel"><b>Utilities</b>power, water, gas</div>
          <div class="hpanel"><b>Advisories</b>what the district has announced</div>
          <div class="hpanel"><b>Who is where</b>by designation, never by name</div>
          <div class="hpanel"><b>Fleet</b>vehicles and teams</div>
          <div class="hpanel"><b>Weather</b>Bajaur's forecast</div>
          <div class="hpanel"><b>This system</b>backup and WhatsApp status</div>
        </div>
      </div>
    </div>
    <p>There are more panels than fit on one screen at once, so <b>the district chooses which
    ones show</b> — see <kbd class="uilabel">Settings → Dashboard layout</kbd> below. <kbd
    class="uilabel">This system</kbd> is only shown to the district's administration, because it
    is theirs to fix — showing everybody something they cannot act on teaches them to stop
    reading red numbers.</p>
  </section>

  <section class="hchapter" id="help-admin">
    <p class="heyebrow">Administration</p>
    <h2>Where the district is set up</h2>
    <p>Visible only to the district's administration. Everything here can be changed without
    anyone writing code.</p>
    <div class="hscreen">
      <div class="hbar">Administration</div>
      <div class="hbody">
        <div class="htabs">
          <span class="htab on">Overview</span><span class="htab">Directory</span>
          <span class="htab">Deadlines</span><span class="htab">Rosters</span>
          <span class="htab">Groups</span><span class="htab">Backups</span>
          <span class="htab">History</span>
        </div>
      </div>
    </div>
    <dl class="hglossary">
      <div class="hglossrow"><dt>Overview</dt><dd>What needs attention, each line leading to
        the place it is fixed.</dd></div>
      <div class="hglossrow"><dt>Directory</dt><dd>Everybody the control room can tell — name,
        number and designation — and a check of whether an emergency reported now would reach
        somebody.</dd></div>
      <div class="hglossrow"><dt>Deadlines</dt><dd>How long there is to answer, by
        severity.</dd></div>
      <div class="hglossrow"><dt>Rosters</dt><dd>The designations and the people holding them,
        with their numbers — a designation that reaches nobody is given a number here.</dd></div>
      <div class="hglossrow"><dt>Groups</dt><dd>Saved sets of recipients that are usually told
        together, so they can be ticked in one go.</dd></div>
      <div class="hglossrow"><dt>Backups</dt><dd>Whether last night's backup ran, and whether a
        copy exists outside the district as well.</dd></div>
      <div class="hglossrow"><dt>History</dt><dd>A permanent record of what was changed here,
        when, and by whom.</dd></div>
    </dl>
    <p>Two things that used to be here have moved: <b>Performance is in the Record</b>, and the
    screens and the dashboard's layout are in <a href="#help-settings">Settings</a>.</p>
    <div class="note warn"><b>Every override needs a reason.</b> If the administration changes
    something that was already entered — a severity, for instance — a reason is required, and
    the original entry stays visible underneath rather than being replaced.</div>
  </section>

  <section class="hchapter" id="help-settings">
    <p class="heyebrow">Settings</p>
    <h2>Accounts, and how this installation is arranged</h2>
    <p>Shown only to the <i>owner</i> and <i>admin</i> roles.</p>
    <dl class="hglossary">
      <div class="hglossrow"><dt>Accounts</dt><dd>Who can sign in, and with which role. An
        account can be suspended, signed out everywhere, or given one permission more or less
        than its role carries.</dd></div>
      <div class="hglossrow"><dt>Access log</dt><dd>Every sign-in and every change to an
        account, with who did it and when.</dd></div>
      <div class="hglossrow"><dt>Security policy</dt><dd>The rules every password and session
        follows.</dd></div>
      <div class="hglossrow"><dt>Which screens are on</dt><dd>Which optional screens this
        installation shows at all. Some start off, and are turned on here in a click.</dd></div>
      <div class="hglossrow"><dt>Dashboard layout</dt><dd>Which dashboard panels show, and at
        what size — arranged against a preview of the actual screen it will appear on.</dd></div>
    </dl>
    <div class="note"><b>An officer's login is not made here.</b> It is given from the Officers
    tab of Activities, or from the contact's own drawer in the Directory, so the login always
    belongs to somebody the Directory already knows.</div>
  </section>

  <section class="hchapter" id="help-reports">
    <p class="heyebrow">Reports</p>
    <h2>What can be downloaded</h2>
    <p>Three links sit below the Record — ready-made files that open in Excel, for sending
    upward.</p>
    <div class="htwrap">
      <table class="htable">
        <tr><th>Report</th><th>What it contains</th></tr>
        <tr><td>Export the last 30 days</td><td>Every incident from the last month — no
          caller's name, number or exact location, only the incident itself.</td></tr>
        <tr><td>Who was told, and who answered</td><td>Any date range: who was told, who
          answered, how long it took, and <b>which of the three ways</b> the answer arrived
          (a tap, a reply, or the operator's own record) — always kept apart, never
          summed.</td></tr>
        <tr><td>What was resolved, and what is still open</td><td>How many incidents closed,
          how long they took, and how many remain open.</td></tr>
      </table>
    </div>
    <p>The two reports by date range are not limited to "the last 30 days" — any month, or any
    single week, can be chosen.</p>
  </section>

  <section class="hchapter" id="help-daily">
    <p class="heyebrow">One day on one page</p>
    <h2>The daily report</h2>
    <p>In the Reports block, <b><kbd class="uilabel">One day, to read and to print</kbd></b>
    opens a single day: every emergency and communication with its stage and who was told, the
    advisories issued, and where officers said they were. <b>Press Ctrl+P and what prints is
    exactly what you read</b> — there is no separate document to drift from the screen.</p>
    <p>A spreadsheet version sits beside it, for anybody doing arithmetic on it.</p>
    <ul>
      <li>The line at the top <b>leads with what went wrong</b> — nobody responded, unreached,
        still open — because one line is what most people read.</li>
      <li>Anything that went wrong is written <b>on the row it belongs to</b>, not counted in a
        corner.</li>
      <li>A day where nothing happened <b>says so in a sentence</b>. It is never a blank page:
        a blank page is a fault somebody has to chase.</li>
    </ul>
  </section>

  <section class="hchapter" id="help-other">
    <p class="heyebrow">Other screens</p>
    <h2>The rest, briefly</h2>
    <dl class="hglossary">
      <div class="hglossrow"><dt>Search</dt><dd>Finding an older emergency — last year's flood,
        for instance. It is the find box on the Record. Off by default on a new installation;
        turned on from Settings → Which screens are on.</dd></div>
      <div class="hglossrow"><dt>Status</dt><dd>Where the district states its own condition —
        power, water, roads, markets — so the dashboard shows more than just emergencies.</dd></div>
    </dl>
  </section>

  <section class="hchapter" id="help-whatsapp">
    <p class="heyebrow">WhatsApp — today, and once it is live</p>
    <h2>What changes when the account arrives</h2>
    <p>The system works fully in both cases. The only thing that changes is <b>how</b> someone
    is told — by hand today, automatically once the account exists.</p>

    <div class="hcompare">
      <div class="hcol now">
        <h4>Today — no WhatsApp Business account yet</h4>
        <ul>
          <li><b><kbd class="uilabel">Reach them</kbd></b> opens the officer's number and lets
            the operator's <b>own phone</b> open WhatsApp or the dialler — the software itself
            sends nothing.</li>
          <li>The operator talks to them directly, then comes back and records what was said
            using <b><kbd class="uilabel">They confirmed</kbd></b> or <b><kbd
            class="uilabel">No answer</kbd></b>.</li>
          <li>This is kept as <b>the operator's own account</b> of the call — a true and
            useful record, just not one the system observed directly.</li>
          <li>The Record and Dashboard say plainly that WhatsApp is not yet configured, rather
            than ever implying a message was sent automatically when it was not.</li>
        </ul>
      </div>
      <div class="hcol later">
        <h4>Once the WhatsApp Business account is live</h4>
        <ul>
          <li>The same <b><kbd class="uilabel">Tell them</kbd></b> button sends the message
            <b>automatically, from the district's own WhatsApp number</b> — nobody has to open
            an app and type it by hand.</li>
          <li>The officer's phone receives a message with a button underneath it. Tapping the
            button confirms it on the spot — and <b>the page it opens then offers the rest</b>:
            mark it responded, mark it resolved, and say where you are. No account, no login.
            See <a href="#help-lifecycle">what the officer can do from the message</a>.</li>
          <li>The system tracks delivery on its own — sent, arrived, seen — but <b>only the
            button being tapped counts as confirmed</b>, never delivery alone.</li>
          <li>If nobody answers, the same phone-call path from today is still there,
            unchanged — nothing is taken away, only added to.</li>
        </ul>
      </div>
    </div>

    <h3>What the message looks like</h3>
    <div class="htemplate" translate="no" dir="ltr">
      <b>District Nerve Center — Bajaur</b><br /><br />
      EMERGENCY · Fire · critical<br /><br />
      Two shops on fire near the bazaar road, a team is needed urgently.<br /><br />
      <span style="font-size:.8rem;color:var(--slate)">Please Acknowledge Below</span>
      <div class="hackbtn">✓ Acknowledge</div>
    </div>
    <p>That button is the important part. Tapping it is what counts as confirmed — because many
    officers have no login to this system at all, but everybody has WhatsApp, and one tap is
    enough to create an attributed record of who confirmed and when.</p>
    <div class="note" style="border-inline-start-color: var(--pending)"><b>An attachment travels as a
    link, not as a file.</b> WhatsApp will only put a document on a message if the template was
    approved to carry one, and the district's template was not. So a PDF or photograph reaches
    the officer as a link inside the message — it opens with no account and lasts two weeks. The
    day a template with a file header is approved, one setting turns the other way on and
    nothing else changes.</div>
    <div class="note"><b>Nothing that works today stops working once this arrives.</b> No
    feature is waiting on the WhatsApp account — only the final "tell them" step moves from a
    phone call to an automatic message, which saves the operator time without changing anything
    about the record itself.</div>
  </section>

  <section class="hchapter" id="help-language">
    <p class="heyebrow">Urdu, and installing the app</p>
    <h2>Two things that make it easier to use</h2>
    <h3>Urdu or English</h3>
    <p>The language button at the top switches every screen, this guide included, between
    English and Urdu. The choice is kept <b>on that device</b>, so one officer's phone can be in
    Urdu while the control room's screen stays in English.</p>
    <p>What people typed is never translated — names, captions, incident details — and neither is
    the WhatsApp message, whose wording is approved as it stands. Numbers stay 0-9, because phone
    and incident numbers are read out and typed back.</p>
    <h3>Install this app</h3>
    <p>On an Android phone or a Windows computer, the <kbd class="uilabel">Install this
    app</kbd> banner puts the system on the home screen in one tap. On an iPhone, use <b>Share →
    Add to Home Screen</b>; the banner shows the steps. It then opens like any other app, with
    no address to type.</p>
  </section>

  <section class="hchapter" id="help-glossary">
    <p class="heyebrow">Glossary</p>
    <h2>A short list of terms</h2>
    <dl class="hglossary">
      <div class="hglossrow"><dt>Control room</dt><dd>The one place this system is entered
        from — it records every emergency and decides who to tell.</dd></div>
      <div class="hglossrow"><dt>Incident</dt><dd>The full record of one emergency, from the
        first report to its closure.</dd></div>
      <div class="hglossrow"><dt>Designation</dt><dd>A responsibility, not a person — "DC" is a
        designation, and whoever holds it changes without the system needing to be told twice. A
        transfer hands it to the next holder automatically. Called a <b>post</b> or a <b>seat</b>
        in older screens and in the record itself; the word on screen is now the district's.</dd></div>
      <div class="hglossrow"><dt>Duty holder</dt><dd>Whoever currently holds a given designation.</dd></div>
      <div class="hglossrow"><dt>Acknowledge / Confirm</dt><dd>An officer stating they know
        about it — by tapping a link, replying, or the operator recording it on their behalf.</dd></div>
      <div class="hglossrow"><dt>Escalate</dt><dd>If nobody answers in time, the system tells
        the next person up the chain on its own — nobody has to remember to.</dd></div>
      <div class="hglossrow"><dt>Override</dt><dd>A correction made by the administration,
        with a reason attached — kept alongside the original entry, never in place of it.</dd></div>
      <div class="hglossrow"><dt>Activity</dt><dd>A post of the day's work — photos, videos or a
        voice note. Kept for 30 days, and never part of an emergency's record.</dd></div>
      <div class="hglossrow"><dt>Member</dt><dd>An officer's login. It opens Activities and
        nothing else.</dd></div>
      <div class="hglossrow"><dt>Directory</dt><dd>Everybody the district can reach: a name, a
        number and a designation.</dd></div>
      <div class="hglossrow"><dt>Off-site backup</dt><dd>A copy of the record kept outside
        Bajaur, so the district's history survives even if the server here does not.</dd></div>
      <div class="hglossrow"><dt>Vacant</dt><dd>A designation with nobody currently holding it — shown
        plainly rather than hidden.</dd></div>
    </dl>
  </section>
`;

/**
 * Marks the guide for Urdu (ADR-0042, E4c): each paragraph, list item, heading or table cell is
 * translated as ONE piece — Urdu orders its words differently, so `<b>` inside a sentence cannot
 * be translated around. Leaf blocks first; then any element holding loose text; then nested marks
 * are dropped so a piece's key (its inner HTML) never contains another piece's marker.
 *
 * ⚠️ `ur.json`'s guide keys are this exact marking's output. Change it and they must be
 * regenerated, or the guide quietly falls back to English.
 */
const BLOCKS = 'p, li, h2, h3, h4, dt, dd, th, td';

function markForUrdu(root: DocumentFragment): void {
  for (const el of Array.from(root.querySelectorAll(BLOCKS))) {
    if (el.querySelector(BLOCKS) === null) el.setAttribute('data-i18n', 'html');
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (n.nodeValue?.trim() === '' || parent === null) continue;
    if (parent.closest('[data-i18n]') !== null) continue;
    parent.setAttribute('data-i18n', 'html');
  }
  for (const el of Array.from(root.querySelectorAll('[data-i18n] [data-i18n]'))) {
    el.removeAttribute('data-i18n');
  }
}

export function mountHelp(): HelpPanel {
  const body = document.getElementById('helpBody');

  // Built once, on first mount, never rebuilt. There is nothing dynamic in here to refresh —
  // it is the same guide whether this is the first incident of the shift or the fortieth.
  let built = false;

  return {
    show(): void {
      if (!built && body !== null) {
        // Authored constant markup, not user or server data — there is nothing here to
        // sanitise, and treating it as untrusted would just be theatre.
        const page = document.createElement('template');
        page.innerHTML = CONTENT;
        markForUrdu(page.content);
        body.replaceChildren(page.content);
        built = true;
      }
    },
  };
}
