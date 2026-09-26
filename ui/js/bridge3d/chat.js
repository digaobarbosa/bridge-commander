// chat.js — talking to a lieutenant, from inside the room.
//
// This is the thing the captain most wants out of the room, and it is the one
// that decides whether any of it was worth building: everything else here is
// looking, and this is the only part that is TALKING. "O chat com o tenente" —
// the lieutenants are how he works, so a room he cannot speak from is a room he
// will visit once.
//
// The panel is `panel.js` with two additions: the thread painted newest at the
// bottom, and a composer in the foot.
//
// **Input, honestly.** The composer is a `Field` — a surface the room draws and
// paints itself; nothing here is ever rendered by the browser. A paired
// Bluetooth keyboard delivers keydown to the document regardless of focus,
// main.js hears it at the window, and it goes to whichever composer holds the
// keys — opening a chat is an intention to talk, so this one takes them, and
// Enter sends.
//
// **And he can just say it.** The Quest system keyboard is off in the room
// because raising it takes the browser down (MNC-87), which left a room with no
// way to put a sentence in it at all unless a keyboard was paired. So the foot
// carries a bar he HOLDS: the whole width of the panel, one press deep, and
// while he holds it the words appear on the strip above — over the board's own
// origin, through `/api/stt` (talk.js). Let go and the bar becomes two: send
// it, or say it again. There is no editing and there was never going to be —
// correcting a word without a keyboard costs more than repeating the sentence.
//
// Which lieutenant is about to hear it is the panel itself: his face and his
// colour are in the bar above, and this surface only ever posts to its own
// `target`.
//
// Sending is `POST /api/feedback` — the captain side of chat.say. Write-ahead:
// the server queues the delivery before it wakes anybody, so a message never
// depends on a session being alive at the moment it is sent.

import * as W from './world.js';
import { Container, Text, COL, cm, fontFor, inert, safe } from './kit.js';
import { Panel } from './panel.js';
import { Field } from './field.js';
import { Target } from './hover.js';
import * as talk from './talk.js';

const D = W.PANEL.distM;

// How much of the thread to paint. A chat here runs to well over a thousand
// messages, and the panel shows fourteen lines — so the tail is what matters
// and the rest is a scroll nobody in a headset wants to do. Enough to hold the
// conversation, few enough that a repaint is not a stall.
const TAIL = 20;

export class ChatPanel extends Panel {
  // `target` is the board's own thread address: `lieutenant:<id>` or
  // `card:<id>`. Deliberately the wire format, so this class never has to know
  // which of the two it is showing.
  constructor({ target, title, subtitle, tint, onClose }) {
    super({ name: 'chat', title, subtitle, tint, onClose });
    this.target = target;
    this.sending = false;
    this._lastPainted = '';
    this.take = null;                 // the utterance in flight, as talk.js reports it

    const pad = W.sizeForArc(1.0, D);
    const barM = W.sizeForArc(W.BUILD.hit, D);

    this.field = new Field({
      box: {
        flexGrow: 1, height: cm(barM), borderRadius: cm(0.010), paddingX: cm(pad * 0.7),
      },
      fontSize: fontFor(W.TYPE.body, D),
      placeholder: 'type, then enter',
      // The panel is 49 characters across and the send button takes a fifth of
      // the foot, so this is what fits beside it.
      chars: 38,
      onSubmit: () => this.send(),
    });

    const sendBox = new Container({
      width: cm(barM * 1.5), height: cm(barM), flexShrink: 0,
      borderRadius: cm(0.010), backgroundColor: COL.mine, backgroundOpacity: 1,
      justifyContent: 'center', alignItems: 'center',
      hover: { backgroundColor: '#2a5f7a' }, active: { backgroundColor: COL.accent },
    });
    const sendMark = new Text({ text: 'send', fontSize: fontFor(W.TYPE.body, D), color: COL.text });
    inert(sendMark);
    sendBox.add(sendMark);

    // ---- the two rows of the foot ------------------------------------------
    //
    // The foot is a column now, and only one of its two rows is ever on: the
    // keyboard row while he is idle, the transcript while he is talking. That
    // is what keeps the body the same height throughout — a thread that jumps
    // by three lines the moment he opens his mouth is a thread he loses his
    // place in.
    this.composeRow = new Container({
      flexDirection: 'row', alignItems: 'center', flexShrink: 0, gap: cm(pad * 0.6),
    });
    this.composeRow.add(this.field.box, sendBox);

    // What it heard, growing while he speaks. Sized to the row it stands in
    // place of so the swap costs nothing, and free to grow past it for a long
    // sentence — this is the one thing on the panel he is actually reading.
    this.heardBox = new Container({
      flexDirection: 'column', justifyContent: 'center', flexShrink: 0, display: 'none',
      minHeight: cm(barM), paddingX: cm(pad * 0.7), paddingY: cm(pad * 0.3),
      borderRadius: cm(0.010), backgroundColor: COL.field, backgroundOpacity: 1,
      borderWidth: cm(0.0018), borderColor: COL.faint, borderOpacity: 0.6,
    });
    inert(this.heardBox);
    this.heard = new Text({ text: '', fontSize: fontFor(W.TYPE.body, D), color: COL.text });
    inert(this.heard);
    this.heardBox.add(this.heard);

    // ---- hold to talk -------------------------------------------------------
    //
    // The whole width of the panel and the full hit floor tall: he is aiming a
    // laser at this from a metre away and it is the control the room now turns
    // on, so it is the biggest thing on the surface.
    // No uikit `hover` block on this one, unlike every other box in the room:
    // uikit lays hover ON TOP of the base colour, so a bar that turns red to say
    // the microphone is open would go back to hover-blue for exactly as long as
    // he is pointing at it — which is the whole time he is holding it. The
    // hover is painted in `paintTake` instead, where it can lose to the red.
    this.holdBox = new Container({
      flexGrow: 1, height: cm(barM), borderRadius: cm(0.010),
      backgroundColor: COL.mine, backgroundOpacity: 1,
      justifyContent: 'center', alignItems: 'center',
    });
    this.holdMark = new Text({ text: 'hold to talk', fontSize: fontFor(W.TYPE.body, D), color: COL.text });
    inert(this.holdMark);
    this.holdBox.add(this.holdMark);

    // And what he is offered once he lets go. Two of them, half a panel each,
    // which is four times the hit floor across — no precision, and no third
    // option, because there is no editing here.
    this.takeSend = this._takeBox(barM, 'send', COL.mine, '#2a5f7a');
    this.takeAgain = this._takeBox(barM, 'again', COL.slot, COL.slotLit);

    this.talkRow = new Container({
      flexDirection: 'row', alignItems: 'center', flexShrink: 0, gap: cm(pad * 0.6),
    });
    this.talkRow.add(this.holdBox, this.takeSend.box, this.takeAgain.box);

    this.foot.setProperties({ display: 'flex', flexDirection: 'column', alignItems: 'stretch' });
    this.foot.add(this.heardBox, this.talkRow, this.composeRow);

    const sendTarget = new Target({ mesh: sendBox, name: 'chat-send', onSelect: () => this.send() });
    sendTarget._paint = () => {};
    const fieldTarget = new Target({
      mesh: this.field.box, name: 'chat-field', onSelect: () => this.field.take(),
    });
    fieldTarget._paint = () => {};
    // `onPress`, not `onSelect`: this one starts on the way DOWN. What ends it
    // is main.js, wired to every way a press can end anywhere in the room —
    // sliding off a bar mid-sentence must not leave the microphone open.
    this.holdTarget = new Target({
      mesh: this.holdBox, name: 'chat-talk', onPress: () => this.startTalking(),
    });
    this.holdTarget._paint = () => this.paintTake();
    this.targets.push(sendTarget, fieldTarget, this.holdTarget,
      this.takeSend.target, this.takeAgain.target);
    this.paintTake();
  }

  // One of the two boxes he gets when he stops speaking.
  _takeBox(barM, mark, colour, lit) {
    const box = new Container({
      flexGrow: 1, height: cm(barM), borderRadius: cm(0.010), display: 'none',
      backgroundColor: colour, backgroundOpacity: 1,
      justifyContent: 'center', alignItems: 'center',
      hover: { backgroundColor: lit }, active: { backgroundColor: COL.accent },
    });
    const t = new Text({ text: mark, fontSize: fontFor(W.TYPE.body, D), color: COL.text });
    inert(t);
    box.add(t);
    const target = new Target({
      mesh: box, name: 'chat-' + mark,
      onSelect: () => (mark === 'send' ? this.sendTake() : this.again()),
    });
    target._paint = () => {};
    return { box, target };
  }

  // ---- dictation -----------------------------------------------------------

  // The trigger went down on the bar. 'again' lands here too: throwing the take
  // away and starting another one is the same act.
  startTalking() {
    talk.begin((s) => {
      // 'idle' is talk.js saying the take this panel was showing is not the one
      // it is holding any more — he started another one somewhere else.
      this.take = s.state === 'idle' ? null : s;
      this.paintTake();
    });
  }

  // Throw the take away and say it again — the only correction there is here.
  again() {
    talk.drop();
    this.take = null;
    // Unless there is no microphone to say it into. Then "again" would error
    // again forever, and the honest thing it can do instead is give him the
    // foot back — the composer, and a bar he can press once the browser has
    // been talked round.
    if (talk.armed()) this.startTalking();
    else this.paintTake();
  }

  // What he heard, as the captain, in this lieutenant's chat. Nothing else
  // sends it — there is no editing step for it to pass through.
  sendTake() {
    const text = this.take && this.take.state === 'heard' ? this.take.text.trim() : '';
    talk.drop();
    this.take = null;
    this.paintTake();
    if (text) this.send(text);
  }

  // The foot, in whichever of its two states it is in. Everything a microphone
  // can do wrong ends up here, in type, on a surface he is standing in front of
  // — there is no console in a headset and no toast composites into a session.
  paintTake() {
    const t = this.take;
    const on = !!t;
    const heard = on && t.state === 'heard';
    const done = heard || (on && t.state === 'error');
    this.heardBox.setProperties({ display: on ? 'flex' : 'none' });
    this.composeRow.setProperties({ display: on ? 'none' : 'flex' });
    const lit = this.holdTarget && this.holdTarget.state !== 'idle';
    this.holdBox.setProperties({
      display: done ? 'none' : 'flex',
      backgroundColor: on ? COL.live : (lit ? '#2a5f7a' : COL.mine),
    });
    this.holdMark.setProperties({
      text: !on ? 'hold to talk' : (t.state === 'recording' ? 'listening — let go to stop' : 'one moment'),
    });
    this.takeSend.box.setProperties({ display: heard ? 'flex' : 'none' });
    this.takeAgain.box.setProperties({ display: done ? 'flex' : 'none' });
    if (!on) return;
    const said = (t.text || '').trim();
    this.heard.setProperties({
      text: safe(t.state === 'error' ? t.why : (said || 'listening…')),
      color: t.state === 'error' ? COL.warn : (said ? COL.text : COL.faint),
    });
  }

  setOpen(on) {
    super.setOpen(on);
    // A chat closing takes its microphone with it. Anything else leaves a take
    // alive on a panel he can no longer see, and a hush nobody will lift.
    if (!on && this.take) { talk.drop(); this.take = null; this.paintTake(); }
    // Opening a chat is an intention to talk, so the composer takes the
    // keyboard without him having to aim at it first — and a room with three
    // chats open never has two of them listening, because taking the keys takes
    // them off whoever had them. Closing gives them back to the room, which is
    // what makes `b`/`c`/`x` work again.
    //
    // `raise: false` is the one thing opening does NOT do. Taking the keys is
    // cheap — a caret, a ring, and his bluetooth keyboard live — but raising the
    // system keyboard puts a shell surface in front of the conversation he has
    // just opened and has not asked to write in yet. Pressing the composer is
    // what asks. It is also, not by accident, the one path that used to take the
    // headset out of the session: whatever the room does automatically the
    // instant a panel opens is the worst place to be wrong.
    if (on) this.field.take({ raise: false }); else this.field.release();
  }

  // Paint the tail of a thread. `messages` is the board's own shape:
  // {author, text, ts}. Cheap-skips when nothing has changed, because this is
  // called on every pushed board and re-laying out forty MSDF paragraphs on a
  // Quest is not free.
  paint(messages) {
    const list = (messages || []).slice(-TAIL);
    const stamp = list.length + '|' + (list.length ? list[list.length - 1].ts : '');
    if (stamp === this._lastPainted) return;
    this._lastPainted = stamp;

    this.clearBody();
    if (!list.length) {
      this.addText('nothing said yet', { size: W.TYPE.meta, color: COL.faint });
      return;
    }
    for (const m of list) {
      const mine = m.author === 'user';
      // Who, once, small — not on every line and never as a second avatar. The
      // colour bar down the side carries it the rest of the way.
      this.addText(
        (mine ? 'you' : (m.author || 'lieutenant')) + '  ' + clock(m.ts),
        { size: W.TYPE.meta, color: COL.faint },
      );
      this.addText(m.text || '', { color: mine ? COL.dim : COL.text });
    }
    this.scrollToEnd();
  }

  // Newest at the bottom, and the panel opens looking at it.
  //
  // It has to wait for a layout pass. uikit only clamps a scroll offset inside
  // its own scroll handler — assigning `scrollPosition` directly is taken at
  // face value, so asking for the end before Yoga has measured the content
  // sends every message a million units off the panel and leaves it looking
  // empty. `maxScrollPosition` is the honest end, and it is not knowable until
  // the paragraphs have been laid out.
  scrollToEnd() { this._toEnd = 3; }

  tick(now) {
    super.tick(now);
    if (!this._toEnd) return;
    const max = this.body.maxScrollPosition && this.body.maxScrollPosition.value;
    if (max && max[1] != null) {
      this.body.scrollPosition.value = [0, max[1]];
      this._toEnd--;                // a couple of passes: the last one sticks
    }
  }

  // `said` is what dictation heard; without it this is the composer's own
  // value. One send path either way — the board has one captain-side chat API
  // and this is it.
  async send(said) {
    const text = (said == null ? (this.field.value || '') : said).trim();
    if (!text || this.sending) return;
    this.sending = true;
    // Cleared straight away rather than on the response: he has pressed enter,
    // the message is gone as far as he is concerned, and a field that empties
    // half a second later reads as a dropped keystroke.
    this.field.setValue('');
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: this.target, text }),
      });
      if (!r.ok) throw new Error(await r.text());
      // Shown immediately, before the next pushed board brings it back — a
      // message that takes a beat to appear feels broken even
      // when it is not.
      this.addText('you  ' + clock(new Date().toISOString()), { size: W.TYPE.meta, color: COL.faint });
      this.addText(text, { color: COL.dim });
      this._lastPainted = '';
      this.scrollToEnd();
    } catch (e) {
      this.addText('not sent - ' + ((e && e.message) || e), { size: W.TYPE.meta, color: '#e08a8a' });
    } finally {
      this.sending = false;
      // Pressing `send` with a ray put the keys wherever they were; typing
      // straight on is the next thing he does either way.
      //
      // `raise: false`, and it is not the same call as pressing the field. If
      // the system keyboard is up it STAYS up — nothing blurred it, and
      // `setValue('')` above already emptied the field under it — so he can
      // keep dictating. Raising here would instead mean that sending with
      // Enter on a bluetooth keyboard summons a keyboard he is not using.
      this.field.take({ raise: false });
    }
  }
}

// The time, and only the time. A date on every message is noise in a
// conversation you are having right now.
function clock(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
