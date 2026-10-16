const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
// Categories the host can pick from
const PACKS = {
  countries: { label: "Countries", noun: "country", items: require("./countries") },
  states: { label: "US States", noun: "state", items: require("./states") },
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const ROUND_MS = 5 * 60 * 1000; // 5 minutes
const rooms = {}; // code -> { hostId, players: {socketId: name}, spies, pack, round, deck }

const newCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sendLobby(code) {
  const r = rooms[code];
  io.to(code).emit("lobby", {
    code, hostId: r.hostId, spies: r.spies, players: Object.values(r.players),
    pack: r.pack,
    packs: Object.entries(PACKS).map(([key, p]) => ({ key, label: p.label })),
  });
}

// Time is up (or host ended the round): stop the clock, but DON'T reveal anything yet
function endRound(code) {
  const r = rooms[code];
  if (!r || !r.round || r.round.ended) return;
  clearTimeout(r.round.timer);
  r.round.ended = true;
  io.to(code).emit("timeUp");
}

// Host presses "Reveal": now everyone sees the country and the spies
function revealRound(code) {
  const r = rooms[code];
  if (!r || !r.round) return;
  clearTimeout(r.round.timer);
  io.to(code).emit("roundOver", { answer: r.round.answer, noun: r.round.noun, spies: r.round.spyNames });
  r.round = null;
}

io.on("connection", (socket) => {
  function joinRoom(code, name) {
    socket.join(code);
    socket.data.code = code;
    rooms[code].players[socket.id] = (name || "Player").slice(0, 20);
    sendLobby(code);
  }

  socket.on("create", (name) => {
    let code;
    do { code = newCode(); } while (rooms[code]);
    rooms[code] = { hostId: socket.id, players: {}, spies: 1, pack: "countries", round: null, deck: [] };
    joinRoom(code, name);
  });

  socket.on("join", ({ code, name }) => {
    code = (code || "").trim().toUpperCase();
    if (!rooms[code]) return socket.emit("errorMsg", "Room not found");
    joinRoom(code, name);
  });

  socket.on("setSpies", (n) => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id) return;
    r.spies = Math.max(1, parseInt(n) || 1);
    sendLobby(socket.data.code);
  });

  socket.on("setPack", (key) => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id || r.round || !PACKS[key]) return;
    r.pack = key;
    r.deck = []; // start a fresh deck for the new category
    sendLobby(socket.data.code);
  });

  socket.on("play", () => {
    const code = socket.data.code, r = rooms[code];
    if (!r || r.hostId !== socket.id || r.round) return;
    const ids = Object.keys(r.players);
    if (r.spies >= ids.length) return socket.emit("errorMsg", "Need more players than spies");

    const pack = PACKS[r.pack];
    if (!r.deck || !r.deck.length) r.deck = shuffle([...pack.items]);
    const item = r.deck.pop();
    const spyIds = new Set(shuffle([...ids]).slice(0, r.spies));
    r.round = {
      answer: item.name,
      noun: pack.noun,
      spyNames: [...spyIds].map((id) => r.players[id]),
      ended: false,
      timer: setTimeout(() => endRound(code), ROUND_MS),
    };
    ids.forEach((id) =>
      io.to(id).emit("role", spyIds.has(id)
        ? { spy: true, hint: item.hint, noun: pack.noun, ms: ROUND_MS }
        : { spy: false, answer: item.name, noun: pack.noun, ms: ROUND_MS })
    );
  });

  socket.on("cancel", () => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id) return;
    endRound(socket.data.code);
  });

  socket.on("reveal", () => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id) return;
    revealRound(socket.data.code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.code, r = rooms[code];
    if (!r) return;
    delete r.players[socket.id];
    const ids = Object.keys(r.players);
    if (!ids.length) {
      if (r.round) clearTimeout(r.round.timer);
      return delete rooms[code];
    }
    if (r.hostId === socket.id) r.hostId = ids[0];
    sendLobby(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
