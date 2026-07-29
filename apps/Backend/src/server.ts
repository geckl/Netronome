import http from "http";
import express from "express";
import cors from "cors";
const app = express()
app.use(cors());
const server = http.createServer(app);
import { Server } from "socket.io";
export const io = new Server(server, { cors: { origin: "http://127.0.0.1/:5173" }, pingInterval: 10000, maxHttpBufferSize: 1e8, connectionStateRecovery: {} });
import path from "path";
const port = 3000
import os from "os";
import { fileURLToPath } from 'url';
import open, {openApp, apps} from 'open';
import { dirname } from 'path';
import Orchestra from "./orchestra.js";
import conductorHandlers from "./conductor.ts";
import performerHandlers from "./performer.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

var networkInterfaces = os.networkInterfaces();
export const ipAddress = Object.values(networkInterfaces).reduce((r: any, list: any) => r.concat(list.reduce((rr: any, i: any) => rr.concat(i.family === 'IPv4' && !i.internal && i.address || []), [])), [])[0];

// Only allow conductor mode to be accessed by the computer running Netronome
const onlyLocal = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  //console.log("Incoming request from IP: ", ip);
  if ( ip === ipAddress || ip === '::ffff:' + ipAddress) {
    next();
  } else {
    res.status(403).send('Access denied: Conductor mode may only be accessed by the computer running Netronome.');
  }
};


app.use(express.static(path.join(__dirname, '../../Performer/build')));
app.use('/conductor', onlyLocal, express.static(path.join(__dirname, '../../Conductor/build')));


// let baselineDate = new Date();
export const orc = new Orchestra();

// Namespaces
var performers = io.of('/');
var conductors = io.of('/conductor');

conductorHandlers(conductors, performers);
performerHandlers(performers, conductors);

server.listen(port, async () => {
  if (ipAddress) {
    console.log("Connect to Metronome here: http://" + ipAddress + ":3000");
    await open(`http://${ipAddress}:3000/conductor`);
  } else {
    console.log("ERROR: NO NETWORK CONNECTION FOUND")
  }
});