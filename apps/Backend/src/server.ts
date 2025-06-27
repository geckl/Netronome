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
import { UUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor', express.static(path.join(__dirname, '../../Conductor/build')));


// let baselineDate = new Date();
const orc = new Orchestra();
const members: Performer[] = [];
let membersCounter = 0;

var networkInterfaces = os.networkInterfaces();
const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family === 'IPv4' && !i.internal && i.address || []), [])), [])[0];

// Namespaces
var conductors = io.of('/conductor');
var performers = io.of('/');


// Conductor Socket
conductors.on('connection', (socket: Socket) => {
  let uuid: UUID = crypto.randomUUID();
  const conductor: Performer = { id: uuid, name: "Conductor", status: "Disconnected", latencies: [] }
  orc.conductor = conductor;
  socket.emit("server-ip", ipAddress);

  socket.on("request-join", () => {
    conductor.status = "Connecting";
  });

  socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
    const latencyPlusOffset = performance.now() - time;
    //const latencyPlusOffset = Date.now() - time;
    cb(latencyPlusOffset);
  });

  // socket.conn.on("heartbeat", () => {
  //   // called after each round trip of the heartbeat mechanism
  //   console.log("heartbeat");
  // });

  socket.on("join-orchestra", (latencies: number[]) => {
    conductor.latencies = latencies;
    conductor.status = "Connected"
    // orc.addPerformer(conductor);
    // conductors.emit("update-members", members);
    console.log("conductor joined orchestra: ", conductor);
  });

  socket.on('conductor-start', (targetTime: number, position: string, cb: (newTargetTime: number) => void) => {
    console.log("Target Time: ", targetTime);
    console.log("Total Latency: ", orc.totalLatency);
    const newTargetTime = targetTime + orc.totalLatency;
    console.log('conductor-start');
    performers.emit('start', newTargetTime, position);
    cb(newTargetTime);
    orc.isPlaying = true;
  });

  socket.on('conductor-stop', () => {
    console.log('conductor-stop');
    performers.emit('stop');
    orc.isPlaying = false;
  });

  socket.on('conductor-change-tempo', (targetTime: number, position: string, newTempo: number, cb: (newTargetTime: number) => void) => {
    console.log("Change Tempo: ", newTempo);
    const newTargetTime = targetTime + orc.totalLatency;
    performers.emit('change-tempo', newTargetTime, position, newTempo);
    cb(newTargetTime);
  })

  // Handle incoming audio stream
  socket.on('audioStream', (audioData: string | ArrayBuffer | null) => {
    performers.emit('audioStream', audioData);
  });
});


// Performer Socket
performers.on('connection', (socket: Socket) => {
  console.log('a user connected');

  let uuid: UUID = crypto.randomUUID();
  const performer: Performer = { id: uuid, name: `Performer #${membersCounter + 1}`, status: "Disconnected", latencies: [] }
  members.push(performer);
  membersCounter++;
  conductors.emit("update-members", members);
  console.log("user connected: ", performer);
  // socket.emit("starttime", baselineDate);

  socket.on("request-join", () => {
    performer.status = "Connecting";
    conductors.emit("update-members", members);
  });

  socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
    const latencyPlusOffset = performance.now() - time;
    //const latencyPlusOffset = Date.now() - time;
    cb(latencyPlusOffset);
  });

  // socket.conn.on("heartbeat", () => {
  //   // called after each round trip of the heartbeat mechanism
  //   console.log("heartbeat");
  // });

  socket.on("join-orchestra", (latencies: number[]) => {
    performer.latencies = latencies;
    performer.status = "Connected"
    orc.addPerformer(performer);
    conductors.emit("update-members", members);
    console.log("user joined orchestra: ", performer);
  });

  socket.on("leave-orchestra", () => {
    if (performer.status === "Connected") {
      orc.removePerformer(performer);
    }
    performer.status = "Disconnected"
    conductors.emit("update-members", members);
    console.log("user left orchestra: ", performer);
  });

  socket.on('connect_error', (err) => {
    console.log(err.message);
  });

  socket.on('disconnect', () => {
    if (performer.status === "Connected") {
      orc.removePerformer(performer);
    }
    let performerIndex = members.map(c => c.id).indexOf(performer.id)
    members.splice(performerIndex, 1);
    conductors.emit("update-members", members);
    console.log("user disconnected: ", members);
  });

  setInterval(() => {
    if (orc.isPlaying) {
      const start = performance.now();
      socket.emit("ping", () => {
        // Normally this number would be divided by two to get one-way latency, but leaving doubled to account for changing latencies
        const latency = (performance.now() - start) / 2;
        performer.latencies.push(latency);
        performer.latencies.shift();
        console.log(performer.name, " LATENCY: ", performer.latencies);
      });
      // conductors.emit("update-members", memebers);
    }
  }, 10000);
});

server.listen(port, () => {
  console.log('listening on *:3000');
  if (ipAddress) {
    console.log("Connect to Metronome here: http://" + ipAddress + ":3000");
  } else {
    console.log("ERROR: NO NETWORK CONNECTION FOUND")
  }
});