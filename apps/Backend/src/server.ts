import http from "http";
import express from "express";
const app = express()
const server = http.createServer(app);
import { Server, Socket } from "socket.io";
const io = new Server(server, { pingInterval: 10000 });
import path from "path";
const port = 3000
import os from "os";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Orchestra from "./orchestra.js";
import { Performer } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor', express.static(path.join(__dirname, '../../Conductor/build')));


let baselineDate = new Date();
const orc = new Orchestra();

var networkInterfaces = os.networkInterfaces();
const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family==='IPv4' && !i.internal && i.address || []), [])), [])[0];

// Namespaces
var conductor = io.of('/conductor');
var performers = io.of('/');


// Conductor Socket
conductor.on('connection', (socket: Socket) => {
  const conductor: Performer = { name: "Conductor", socket: socket, latency: 0 }
  orc.conductor = conductor;
  socket.emit("server-ip", ipAddress);

  socket.on('conductor-start', (targetTime: number, position: string) => {
    console.log('conductor-start');
    performers.emit('start', targetTime, position);
  });

  socket.on('conductor-stop', () => {
    console.log('conductor-stop');
    performers.emit('stop')
  });

  // Handle incoming audio stream
  socket.on('audioStream', (audioData: string | ArrayBuffer | null) => {
    performers.emit('audioStream', audioData);
  });
});


// Performer Socket
performers.on('connection', (socket: Socket) => {
  console.log('a user connected');

  const performer: Performer = { name: `Performer #${orc.performers.length + 1}`, socket: socket, latency: 0 }
  orc.addPerformer(performer);
  socket.emit("starttime", baselineDate);

  socket.on("ping", (time: number, cb:(latency: number)=> void ) => {
    const start = Date.now();
    const latency = start - time;
    if (typeof cb === "function") {
      cb(latency);
    }
    performer.latency = latency;
    console.log(performer.name, " LATENCY: ", latency);
  });

  // socket.conn.on("heartbeat", () => {
  //   // called after each round trip of the heartbeat mechanism
  //   console.log("heartbeat");
  // });

  socket.on('connect_error', (err) => {
    console.log(err.message);
  })

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

server.listen(port, () => {
  console.log('listening on *:3000');
  if (ipAddress) {
    console.log("Connect to Metronome here: http://" + ipAddress + ":3000");
  } else {
    console.log("ERROR: NO NETWORK CONNECTION FOUND")
  }
});