import http from "http";
import express from "express";
const app = express()
const server = http.createServer(app);
import { Server, Socket } from "socket.io";
const io = new Server(server, {pingInterval: 5000});
import path from "path";
const port = 3000
import os from "os";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor',express.static(path.join(__dirname, '../../Conductor/build')));

// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, '../../Performer/build', "index.html"));
// });

// app.get('conductor/*', (req, res) => {
//     res.sendFile(path.join(__dirname, '../../Conductor/build', "index.html"));
// });

let baselineDate = new Date();

io.on('connection', (socket: Socket) => {
console.log('a user connected');

let latency = 0;

socket.emit("starttime", baselineDate );

socket.on("ping", (cb) => {
    if (typeof cb === "function")
      cb();
  });

  socket.conn.on("heartbeat", () => {
    // called after each round trip of the heartbeat mechanism
    console.log("heartbeat");
  });

socket.on('conductor-start', (msg: number) => {
    console.log('conductor-start');
    socket.broadcast.emit('start', msg)
  });

  socket.on('conductor-stop', (msg) => {
    console.log('conductor-stop');
    socket.broadcast.emit('stop')
  });

// Handle incoming audio stream
socket.on('audioStream', (audioData) => {
    socket.broadcast.emit('audioStream', audioData);
});

socket.on('connect_error', (err) => {
    console.log(err.message);
})

socket.on('disconnect', () => {
    console.log('user disconnected');
    });
});
  
server.listen(port, () => {
console.log('listening on *:3000');
var networkInterfaces = os.networkInterfaces();
if(networkInterfaces['en0'])
{
console.log("Connect to Metronome here: http://" + networkInterfaces['en0'][0].address + ":3000");
} else {
  console.log("ERROR: NO NETWORK CONNECTION FOUND")
}
});