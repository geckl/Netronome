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
const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family === 'IPv4' && !i.internal && i.address || []), [])), [])[0];

// Namespaces
var conductor = io.of('/conductor');
var performers = io.of('/');


// Conductor Socket
conductor.on('connection', (socket: Socket) => {
  const conductor: Performer = { name: "Conductor", socket: socket, latencies: [] }
  orc.conductor = conductor;
  socket.emit("server-ip", ipAddress);

  socket.on('conductor-start', (targetTime: number, position: string, cb: (newTargetTime: number) => void) => {
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

  // Handle incoming audio stream
  socket.on('audioStream', (audioData: string | ArrayBuffer | null) => {
    performers.emit('audioStream', audioData);
  });
});


// Performer Socket
performers.on('connection', (socket: Socket) => {
  console.log('a user connected');

  const performer: Performer = { name: `Performer #${orc.performers.length + 1}`, socket: socket, latencies: [] }
  socket.emit("starttime", baselineDate);

  socket.on("calculate-latency", (time: number, cb: (latency: number) => void) => {
    const latencyPlusOffset = Date.now() - time;
    if (typeof cb === "function") {
      cb(latencyPlusOffset);
    }
    // console.log(performer.name, " LATENCY: ", latencyPlusOffset);
  });

  // socket.conn.on("heartbeat", () => {
  //   // called after each round trip of the heartbeat mechanism
  //   console.log("heartbeat");
  // });

  socket.on("report-latency", (latencies: number[]) => {
    performer.latencies = latencies;
    orc.addPerformer(performer);
  })

  socket.on('connect_error', (err) => {
    console.log(err.message);
  })

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });

  setInterval(() => {
    if (orc.isPlaying) {
      const start = Date.now();
      socket.emit("ping", () => {
        // Normally this number would be divided by two to get one-way latency, but leaving doubled to account for changing latencies
        const latency = (Date.now() - start)/2;
        performer.latencies.push(latency);
        performer.latencies.shift();
        console.log(performer.name, " LATENCY: ", performer.latencies);
      });
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