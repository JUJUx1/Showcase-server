const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

let games = [];

const ADMIN_TOKEN = "zeta_secret_token";

app.get("/", (req,res)=>{
  res.send("Server Running");
});

app.get("/games", (req, res) => {
  res.json(games);
});

app.post("/add", (req, res) => {
  if (req.headers.authorization !== ADMIN_TOKEN)
    return res.status(403).json({ error: "Unauthorized" });

  games.push(req.body);
  io.emit("update", games);
  res.json({ success: true });
});

app.post("/delete", (req, res) => {
  if (req.headers.authorization !== ADMIN_TOKEN)
    return res.status(403).json({ error: "Unauthorized" });

  games = games.filter(g => g.id !== req.body.id);
  io.emit("update", games);
  res.json({ success: true });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
