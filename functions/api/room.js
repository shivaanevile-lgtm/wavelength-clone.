// Cloudflare Pages Function: /api/room
// Handles all game state for the Wavelength-style party game.
// Storage: a single JSON blob per room in the ROOMS KV namespace.

const ROOM_TTL_SECONDS = 60 * 60 * 6; // 6 hours

const SPECTRUMS = [
  ["Bad", "Good"], ["Cheap", "Expensive"], ["Cold", "Hot"],
  ["Overrated", "Underrated"], ["Common", "Rare"], ["Boring", "Exciting"],
  ["Small", "Large"], ["Unhealthy", "Healthy"], ["Simple", "Complex"],
  ["Weak", "Strong"], ["Ugly", "Beautiful"], ["Old", "Modern"],
  ["Quiet", "Loud"], ["Slow", "Fast"], ["Safe", "Dangerous"],
  ["Sad", "Happy"], ["Easy", "Hard"], ["Fake", "Real"],
  ["Casual", "Formal"], ["Introvert", "Extrovert"], ["Indoor", "Outdoor"],
  ["Practical", "Impractical"], ["Niche", "Mainstream"], ["Modest", "Extravagant"],
  ["Guilty pleasure", "Genuinely great"], ["Underwhelming", "Overwhelming"],
  ["Low effort", "High effort"], ["Local", "Global"], ["Traditional", "Modern"],
  ["Chaotic", "Orderly"], ["Predictable", "Surprising"], ["Cheap thrill", "Investment"],
  ["Basic", "Fancy"], ["Silly", "Serious"], ["Underdog", "Favorite"],
  ["Awkward", "Smooth"], ["Risky", "Cautious"], ["Nostalgic", "Futuristic"],
  ["Understated", "Flashy"], ["Skippable", "Essential"], ["Niche hobby", "Everyone's into it"],
  ["Kid-friendly", "Adults only"], ["Cozy", "Adventurous"], ["Cheap date", "Expensive date"],
  ["Forgettable", "Iconic"], ["Overhyped", "Underhyped"], ["Solo activity", "Group activity"],
];

function randCode(){
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 4; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}
function randId(){
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function err(message, status = 400){
  return json({ error: message }, status);
}
async function loadRoom(kv, code){
  if (!code) return null;
  const raw = await kv.get(`room:${code.toUpperCase()}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveRoom(kv, room){
  room.updatedAt = Date.now();
  await kv.put(`room:${room.code}`, JSON.stringify(room), { expirationTtl: ROOM_TTL_SECONDS });
}
function pickSpectrum(){
  const pair = SPECTRUMS[Math.floor(Math.random() * SPECTRUMS.length)];
  return Math.random() < 0.5 ? pair : [pair[1], pair[0]];
}
function scoreFor(target, guess){
  const diff = Math.abs(target - guess);
  if (diff <= 3) return 4;
  if (diff <= 8) return 3;
  if (diff <= 15) return 2;
  if (diff <= 25) return 1;
  return 0;
}
function redact(room, playerId){
  const isPsychic = room.psychicId === playerId;
  const canSeeTarget = isPsychic || room.phase === "reveal" || room.phase === "end";
  const out = { ...room };
  if (!canSeeTarget) delete out.target;
  return out;
}

export async function onRequestPost(context){
  const { request, env } = context;
  const kv = env.ROOMS;
  if (!kv) return err("Server misconfigured: missing ROOMS KV binding.", 500);

  let body;
  try { body = await request.json(); } catch (e) { return err("Invalid request body."); }
  const { action } = body;

  if (action === "create") {
    const name = (body.name || "").trim().slice(0, 18);
    const totalRounds = Math.max(4, Math.min(20, parseInt(body.totalRounds, 10) || 8));
    if (!name) return err("Name is required.");

    let code;
    for (let i = 0; i < 8; i++) {
      code = randCode();
      if (!(await kv.get(`room:${code}`))) break;
    }
    const playerId = randId();
    const room = {
      code, hostId: playerId, createdAt: Date.now(),
      players: [{ id: playerId, name }],
      teamA: [], teamB: [],
      started: false, phase: "lobby",
      round: 0, totalRounds,
      activeTeam: "A", psychicId: null,
      pointerA: 0, pointerB: 0,
      spectrumLeft: "", spectrumRight: "",
      target: null, clue: "", guess: null,
      scoreA: 0, scoreB: 0, lastPoints: 0,
    };
    await saveRoom(kv, room);
    return json({ code, playerId });
  }

  if (action === "join") {
    const name = (body.name || "").trim().slice(0, 18);
    const code = (body.code || "").trim().toUpperCase();
    if (!name || !code) return err("Name and room code are required.");
    const room = await loadRoom(kv, code);
    if (!room) return err("Room not found.", 404);
    if (room.started) return err("This game already started.");
    const playerId = randId();
    room.players.push({ id: playerId, name });
    await saveRoom(kv, room);
    return json({ code: room.code, playerId });
  }

  // All remaining actions need an existing room + player
  const code = (body.code || "").trim().toUpperCase();
  const room = await loadRoom(kv, code);
  if (!room) return err("Room not found.", 404);
  const playerId = body.playerId;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return err("You're not in this room.", 403);

  if (action === "assignTeams") {
    if (room.hostId !== playerId) return err("Only the host can assign teams.");
    const shuffled = [...room.players.map(p => p.id)].sort(() => Math.random() - 0.5);
    room.teamA = []; room.teamB = [];
    shuffled.forEach((id, i) => (i % 2 === 0 ? room.teamA : room.teamB).push(id));
    await saveRoom(kv, room);
    return json({ ok: true });
  }

  if (action === "start") {
    if (room.hostId !== playerId) return err("Only the host can start the game.");
    if (room.teamA.length < 1 || room.teamB.length < 1) return err("Both teams need at least one player.");
    room.started = true;
    room.round = 1;
    room.activeTeam = "A";
    room.pointerA = 0; room.pointerB = 0;
    room.psychicId = room.teamA[0];
    const [l, r] = pickSpectrum();
    room.spectrumLeft = l; room.spectrumRight = r;
    room.target = Math.floor(Math.random() * 101);
    room.clue = ""; room.guess = null; room.lastPoints = 0;
    room.phase = "clue";
    await saveRoom(kv, room);
    return json({ ok: true });
  }

  if (action === "submitClue") {
    if (room.phase !== "clue") return err("Not accepting a clue right now.");
    if (room.psychicId !== playerId) return err("Only the psychic can give the clue.");
    const clue = (body.clue || "").trim().slice(0, 120);
    if (!clue) return err("Clue can't be empty.");
    room.clue = clue;
    room.phase = "guess";
    await saveRoom(kv, room);
    return json({ ok: true });
  }

  if (action === "submitGuess") {
    if (room.phase !== "guess") return err("Not accepting a guess right now.");
    const activeList = room.activeTeam === "A" ? room.teamA : room.teamB;
    if (!activeList.includes(playerId) || playerId === room.psychicId) {
      return err("Only guessing teammates can submit a guess.");
    }
    let guess = parseInt(body.guess, 10);
    if (isNaN(guess)) return err("Invalid guess.");
    guess = Math.max(0, Math.min(100, guess));
    room.guess = guess;
    const points = scoreFor(room.target, guess);
    room.lastPoints = points;
    if (room.activeTeam === "A") room.scoreA += points; else room.scoreB += points;
    room.phase = "reveal";
    await saveRoom(kv, room);
    return json({ ok: true });
  }

  if (action === "nextRound") {
    if (room.phase !== "reveal") return err("Round isn't finished yet.");
    if (room.hostId !== playerId && room.psychicId !== playerId) {
      return err("Only the host or the current psychic can advance the round.");
    }
    if (room.round >= room.totalRounds) {
      room.phase = "end";
      await saveRoom(kv, room);
      return json({ ok: true });
    }
    room.round += 1;
    room.activeTeam = room.activeTeam === "A" ? "B" : "A";
    if (room.activeTeam === "A") {
      room.pointerA = (room.pointerA + 1) % room.teamA.length;
      room.psychicId = room.teamA[room.pointerA];
    } else {
      room.pointerB = (room.pointerB + 1) % room.teamB.length;
      room.psychicId = room.teamB[room.pointerB];
    }
    const [l, r] = pickSpectrum();
    room.spectrumLeft = l; room.spectrumRight = r;
    room.target = Math.floor(Math.random() * 101);
    room.clue = ""; room.guess = null; room.lastPoints = 0;
    room.phase = "clue";
    await saveRoom(kv, room);
    return json({ ok: true });
  }

  return err("Unknown action.");
}

export async function onRequestGet(context){
  const { request, env } = context;
  const kv = env.ROOMS;
  if (!kv) return err("Server misconfigured: missing ROOMS KV binding.", 500);

  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  const playerId = url.searchParams.get("playerId") || "";
  const room = await loadRoom(kv, code);
  if (!room) return err("Room not found.", 404);
  if (!room.players.find(p => p.id === playerId)) return err("You're not in this room.", 403);
  return json(redact(room, playerId));
}
