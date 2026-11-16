// Owner traffic tracker (counts only): one anonymous random ID per tab,
// page views + 60 s heartbeats + whitelisted button presses. No IPs, no
// transcripts, no audio. Every send is fire-and-forget and can never break
// the app; when the server says the tracker is not configured it simply
// answers { enabled: false } and nothing more is sent.
(function () {
  'use strict';
  var PRESS_MAP = {
    connectBtn: 'connect',
    startAttemptBtn: 'attempt_start',
    retryBtn: 'retry',
    sampleABtn: 'sample_play',
    sampleBBtn: 'sample_play',
    debateSampleBtn: 'sample_play',
    interviewSampleBtn: 'sample_play',
    debateStartBtn: 'debate_start', // text and voice debates share this button
    roundStartBtn: 'debate_round_start',
    diagnoseBtn: 'diagnose_debate',
    endVoiceBtn: 'diagnose_debate',
    interviewStartBtn: 'interview_start',
    answerStartBtn: 'interview_answer_start',
    diagnoseInterviewBtn: 'diagnose_interview',
  };

  // Random per-tab ID (sessionStorage: survives reloads in this tab, dies
  // with the tab). Never an IP, never linked to anything a user typed.
  var session;
  try {
    session = sessionStorage.getItem('orator_ts');
    if (!session) {
      session = (window.crypto && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem('orator_ts', session);
    }
  } catch (e) {
    session = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function send(type, name) {
    try {
      var body = JSON.stringify({ type: type, name: name || null, session: session });
      var ok = false;
      try {
        ok = navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      } catch (e) { /* fall through to fetch */ }
      if (!ok) {
        fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) { /* tracking must never break the app */ }
  }

  send('view'); // doubles as this tab's first heartbeat

  // Heartbeat only while the tab is actually being viewed, so "viewers
  // right now" means people looking at the page, not open background tabs.
  setInterval(function () {
    if (document.visibilityState === 'visible') send('heartbeat');
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') send('heartbeat');
  });

  // One delegated listener: counts the press intent on whitelisted buttons
  // without touching any of the app's own handlers.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('button') : null;
    var name = el && PRESS_MAP[el.id];
    if (name) send('press', name);
  }, true);
})();
