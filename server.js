const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const countries = require("./countries");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const ROUND_MS = 5 * 60 * 1000; // 5 minutes
const rooms = {}; // code -> { hostId, players: {socketId: name}, spies, round, deck }

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
  io.to(code).emit("roundOver", { country: r.round.country, spies: r.round.spyNames });
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
    rooms[code] = { hostId: socket.id, players: {}, spies: 1, round: null, deck: [] };
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

  socket.on("play", () => {
    const code = socket.data.code, r = rooms[code];
    if (!r || r.hostId !== socket.id || r.round) return;
    const ids = Object.keys(r.players);
    if (r.spies >= ids.length) return socket.emit("errorMsg", "Need more players than spies");

    if (!r.deck || !r.deck.length) r.deck = shuffle([...countries]);
    const country = r.deck.pop();
    const spyIds = new Set(shuffle([...ids]).slice(0, r.spies));
    r.round = {
      country: country.name,
      spyNames: [...spyIds].map((id) => r.players[id]),
      ended: false,
      timer: setTimeout(() => endRound(code), ROUND_MS),
    };
    ids.forEach((id) =>
      io.to(id).emit("role", spyIds.has(id)
        ? { spy: true, hint: country.hint, ms: ROUND_MS }
        : { spy: false, country: country.name, ms: ROUND_MS })
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