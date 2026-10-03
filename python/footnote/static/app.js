const IDEAS = ["Octopuses", "The Apollo program", "Bebop", "Byzantine Empire", "Volcanoes", "Studio Ghibli"];

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function name() {
  return localStorage.getItem("footnoteName") || "Player";
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || `HTTP ${res.status}`);
  if (json && json.success === false) throw new Error(json.error);
  return json?.data ?? json;
}

function route() {
  const m = location.pathname.match(/^\/play\/([A-Za-z]{1,8})/i);
  return m ? { page: "play", code: m[1].toUpperCase() } : { page: "home" };
}

async function ensureName() {
  let n = localStorage.getItem("footnoteName");
  if (!n) {
    n = (prompt("Your name on the scoreboard", "Player") || "Player").slice(0, 40);
    localStorage.setItem("footnoteName", n);
  }
  await api("/api/session", { name: n }).catch(() => {});
  return n;
}

function renderHome() {
  const root = document.getElementById("root");
  root.innerHTML = "";
  const wrap = el(`<div class="wrap">
    <p class="note">Python port of Footnote — DeepSpace app is unchanged at testproject.app.space</p>
    <div class="hero">
      <section>
        <p class="kicker font-code">Live trivia · cited to Wikipedia</p>
        <h1 class="font-display">Any topic becomes a quiz night<span>.</span></h1>
        <p class="lede">Name a subject. Footnote reads Wikipedia, writes the questions, and runs the game live. Every answer comes with its source.</p>
        <ol class="steps">
          <li><span class="n">1</span><span>Pick a topic. Questions are drawn only from the articles it finds.</span></li>
          <li><span class="n">2</span><span>Share the four-letter code. Friends join from any device.</span></li>
          <li><span class="n">3</span><span>Answer fast for more points. The reveal links to the line it came from.</span></li>
        </ol>
      </section>
      <section class="card" id="panel"></section>
    </div>
  </div>`);
  root.append(wrap);
  const panel = wrap.querySelector("#panel");
  let tab = "host";
  let topic = "";
  let count = "8";
  let seconds = "20";
  let code = "";
  let err = "";
  let busy = false;

  function paint() {
    panel.innerHTML = "";
    const tabs = el(`<div class="tabs">
      <button class="${tab === "host" ? "on" : ""}" data-t="host">Host a game</button>
      <button class="${tab === "join" ? "on" : ""}" data-t="join">Join with code</button>
    </div>`);
    tabs.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        tab = b.dataset.t;
        paint();
      }),
    );
    panel.append(tabs);
    if (tab === "host") {
      const form = el(`<form>
        <label for="topic">Topic</label>
        <input id="topic" value="${topic.replace(/"/g, "&quot;")}" placeholder="e.g. The Apollo program" maxlength="80" />
        <div class="ideas">${IDEAS.map((i) => `<button type="button" data-idea="${i}">${i}</button>`).join("")}</div>
        <div class="row2" style="margin-top:1rem">
          <div>
            <label>Questions</label>
            <select id="count">${[5, 8, 10, 12].map((n) => `<option ${n == count ? "selected" : ""}>${n}</option>`).join("")}</select>
          </div>
          <div>
            <label>Time per question</label>
            <select id="secs">${[10, 20, 30].map((n) => `<option ${n == seconds ? "selected" : ""}>${n}</option>`).join("")}</select>
          </div>
        </div>
        ${err ? `<p class="err">${err}</p>` : ""}
        <button class="primary" style="width:100%;margin-top:1rem" ${busy ? "disabled" : ""}>${busy ? "Opening your room…" : "Write my quiz"}</button>
        <p class="hint">Room opens right away. Share the code while questions are written. Set ANTHROPIC_API_KEY for Claude-written questions; otherwise they are extracted from Wikipedia sentences.</p>
      </form>`);
      form.querySelectorAll("[data-idea]").forEach((b) =>
        b.addEventListener("click", () => {
          topic = b.dataset.idea;
          form.querySelector("#topic").value = topic;
        }),
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        topic = form.querySelector("#topic").value.trim();
        count = form.querySelector("#count").value;
        seconds = form.querySelector("#secs").value;
        if (topic.length < 2) {
          err = "Enter a topic.";
          paint();
          return;
        }
        busy = true;
        err = "";
        paint();
        try {
          const n = await ensureName();
          const data = await api("/api/actions/createGame", {
            topic,
            questionCount: Number(count),
            secondsPerQuestion: Number(seconds),
            name: n,
          });
          history.pushState({}, "", `/play/${data.code}`);
          boot();
        } catch (ex) {
          err = ex.message;
          busy = false;
          paint();
        }
      });
      panel.append(form);
    } else {
      const form = el(`<form>
        <label>Room code</label>
        <input id="code" class="font-code" style="text-align:center;font-size:1.75rem;letter-spacing:.4em;text-transform:uppercase;height:4rem" value="${code}" maxlength="4" placeholder="ABCD" />
        <button class="primary" style="width:100%;margin-top:1rem">Join game</button>
      </form>`);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        code = form.querySelector("#code").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
        if (code.length !== 4) return;
        await ensureName();
        history.pushState({}, "", `/play/${code}`);
        boot();
      });
      panel.append(form);
    }
  }
  paint();
}

function renderPlay(code) {
  const root = document.getElementById("root");
  root.innerHTML = `<div class="wrap-sm" id="room"><p class="kicker font-code">Connecting to ${code}…</p></div>`;
  const room = document.getElementById("room");
  let state = null;
  let picked = null;
  let ws;

  function toast(msg) {
    const t = el(`<div class="toast">${msg}</div>`);
    document.body.append(t);
    setTimeout(() => t.remove(), 2000);
  }

  async function act(name, body) {
    try {
      await api(`/api/actions/${name}`, body);
    } catch (ex) {
      toast(ex.message);
    }
  }

  function paint() {
    if (!state) return;
    const g = state.game;
    const q = state.question;
    const players = state.players || [];
    const me = state.me;
    const isHost = g.hostId && me && g.hostId === me.userId;
    const remaining = Math.max(0, g.questionStartedAt + g.secondsPerQuestion * 1000 - Date.now());
    const answered = players.filter((p) => (p.lastAnsweredIndex ?? -1) >= g.currentIndex).length;

    let body = "";
    if (g.status === "generating" || g.status === "lobby" || g.status === "failed") {
      body = `
        <div class="banner">
          <p class="kicker">Join with code</p>
          <p class="code font-code">${g.code}</p>
          <button class="outline" id="copy">Copy invite link</button>
        </div>
        ${
          g.status === "generating"
            ? `<div class="card" style="margin-top:1.25rem">
                <div style="display:flex;justify-content:space-between"><strong>${g.generationMessage || "Writing…"}</strong><span class="font-code">${Math.round((g.generationProgress || 0) * 100)}%</span></div>
                <div class="bar" style="margin-top:.5rem"><i style="width:${Math.max(4, (g.generationProgress || 0) * 100)}%"></i></div>
              </div>`
            : ""
        }
        ${
          g.status === "failed"
            ? `<div class="card" style="margin-top:1.25rem;text-align:center"><p>${g.generationError || "Could not write the quiz."}</p><a class="primary" href="/">Try another topic</a></div>`
            : ""
        }
        <h2 class="kicker" style="margin-top:1.5rem">${players.length} waiting</h2>
        <div class="chips">${players
          .map(
            (p) =>
              `<span class="chip"><span class="dot ${p.online ? "on" : ""}"></span>${p.name}${p.isHost ? " ★" : ""}</span>`,
          )
          .join("")}</div>
        ${
          g.status === "lobby" && g.sources?.length
            ? `<p class="kicker" style="margin-top:1.5rem">${g.questionCount} questions from</p><ol>${g.sources
                .map((s, i) => `<li><a href="${s.url}" target="_blank">[${i + 1}] ${s.title}</a></li>`)
                .join("")}</ol>`
            : ""
        }
        <div class="sticky">${
          g.status === "lobby"
            ? isHost
              ? `<button class="primary" id="start">Start the game</button>`
              : `<p>Waiting for ${g.hostName || "the host"}…</p>`
            : g.status === "generating"
              ? `<p>Questions are being written — hang tight…</p>`
              : ""
        }</div>`;
    } else if (g.status === "question" && q) {
      const lock = state.mySub || picked != null;
      body = `
        <div class="timer"><div class="bar"><i style="width:${(remaining / (g.secondsPerQuestion * 1000)) * 100}%"></i></div><span class="font-code" style="font-size:1.5rem">${Math.ceil(remaining / 1000)}</span></div>
        <h2 class="font-display" style="font-size:1.75rem">${q.prompt}</h2>
        <div class="choices">${q.choices
          .map((c, i) => `<button class="choice ${state.mySub?.choice === i || picked === i ? "picked" : ""}" data-c="${i}">${c}</button>`)
          .join("")}</div>
        <p style="text-align:center;color:var(--muted)">${lock ? "Locked in. " : ""}${answered} of ${players.length} answered</p>`;
    } else if (g.status === "reveal" && q) {
      const mine = state.mySub;
      const ok = mine && mine.choice === q.correctIndex;
      body = `
        <div class="result ${ok ? "ok" : "no"}"><span>${!mine ? "No answer in time" : ok ? "Correct!" : "Not quite"}</span><span class="font-code">+${me?.lastPoints || 0}</span></div>
        <h2 class="font-display" style="font-size:1.75rem">${q.prompt}</h2>
        <div class="choices">${q.choices
          .map((c, i) => {
            const cls = i === q.correctIndex ? "right" : mine?.choice === i ? "wrong picked" : "";
            const dist = q.distribution ? ` · ${q.distribution[i] || 0}` : "";
            return `<div class="choice ${cls}">${c}${dist}</div>`;
          })
          .join("")}</div>
        <aside class="foot">${q.explanation || ""}<div><a href="${q.sourceUrl}" target="_blank">${q.sourceTitle}, Wikipedia</a></div></aside>
        <ol class="stand">${players
          .slice()
          .sort((a, b) => b.score - a.score)
          .map((p) => `<li><span>${p.name}</span><span class="font-code">${p.score}</span></li>`)
          .join("")}</ol>
        <div class="sticky">${isHost ? `<button class="primary" id="next">${g.currentIndex + 1 >= g.questionCount ? "See final results" : "Next question"}</button>` : `<p>Waiting for ${g.hostName}…</p>`}</div>`;
    } else if (g.status === "finished") {
      const ranked = players.slice().sort((a, b) => b.score - a.score);
      body = `<p class="kicker">Final results</p><h2 class="font-display">${ranked[0]?.name || "Someone"} wins.</h2>
        <ol class="stand">${ranked.map((p) => `<li><span>${p.name}</span><span class="font-code">${p.score}</span></li>`).join("")}</ol>
        <p class="kicker">Footnotes</p>
        <ol>${(g.sources || []).map((s) => `<li><a href="${s.url}" target="_blank">${s.title}</a></li>`).join("")}</ol>
        <p style="text-align:center;margin-top:2rem"><a class="primary" href="/">Host another topic</a></p>`;
    }

    room.innerHTML = `
      <header class="room">
        <div>
          <p class="kicker font-code">Game <strong>${g.code}</strong>${g.status === "question" || g.status === "reveal" ? ` · Question ${g.currentIndex + 1} of ${g.questionCount}` : ""}</p>
          <h1 class="font-display" style="font-size:1.75rem;margin:0">${g.topic}</h1>
        </div>
        ${me && g.status !== "generating" && g.status !== "failed" ? `<p>Your score <span class="me font-code">${me.score}</span></p>` : ""}
      </header>
      ${body}`;

    room.querySelector("#copy")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(location.href);
      toast("Invite link copied");
    });
    room.querySelector("#start")?.addEventListener("click", () => act("startGame", { gameId: g.id }));
    room.querySelector("#next")?.addEventListener("click", () => act("nextQuestion", { gameId: g.id, fromIndex: g.currentIndex }));
    room.querySelectorAll(".choice[data-c]").forEach((b) =>
      b.addEventListener("click", () => {
        if (picked != null || state.mySub) return;
        picked = Number(b.dataset.c);
        act("submitAnswer", { gameId: g.id, index: q.index, choice: picked });
        paint();
      }),
    );

    if (g.status === "question" && q) {
      const timeUp = remaining <= 0;
      const everyone = players.length > 0 && answered === players.length;
      if (timeUp || everyone) act("revealQuestion", { gameId: g.id, index: q.index });
    }
  }

  let tick;
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${code}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "error") {
        room.innerHTML = `<p>No game with code ${code}.</p><p><a href="/">Back</a></p>`;
        return;
      }
      if (msg.type === "state") {
        const prev = state?.game?.currentIndex;
        state = msg.data;
        if (prev !== state.game.currentIndex) picked = null;
        paint();
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }

  ensureName().then(async (n) => {
    await api("/api/actions/joinGame", { code, name: n }).catch(() => {});
    connect();
    tick = setInterval(() => state?.game?.status === "question" && paint(), 200);
  });
  window.addEventListener("beforeunload", () => {
    clearInterval(tick);
    ws?.close();
  });
}

function boot() {
  const r = route();
  if (r.page === "play") renderPlay(r.code);
  else renderHome();
}

window.addEventListener("popstate", boot);
boot();
