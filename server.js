const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = "zeta_secret_token";

// Create uploads folder if not exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

let games = [];

// Root
app.get("/", (req, res) => {
  res.send("Game Showcase Server Running");
});

// Get all games
app.get("/games", (req, res) => {
  res.json(games);
});

// Add game
app.post("/add", upload.single("image"), (req, res) => {
  if (req.headers.authorization !== ADMIN_TOKEN)
    return res.status(403).json({ error: "Unauthorized" });

  const newGame = {
    id: Date.now(),
    title: req.body.title,
    description: req.body.description,
    link: req.body.link,
    image: req.file
      ? `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
      : ""
  };

  games.push(newGame);
  io.emit("update", games);

  res.json({ success: true });
});

// Delete game
app.post("/delete", (req, res) => {
  if (req.headers.authorization !== ADMIN_TOKEN)
    return res.status(403).json({ error: "Unauthorized" });

  games = games.filter(g => g.id != req.body.id);
  io.emit("update", games);

  res.json({ success: true });
});

server.listen(PORT, () => console.log("Server running on port", PORT));