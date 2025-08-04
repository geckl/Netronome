import { Performer } from "./types.js";

class Orchestra {
    public name: string = "Test";
    public isPlaying: boolean = false;
    public conductor: Performer | null = null;
    public performers: Performer[] = [];
    public tempo: number = 60;
    public baseTime: number = 0;
    public totalLatency: number = 0;
    public backtrack: ArrayBuffer | null = null;
    constructor() { }

    public addPerformer(p: Performer) {
        this.performers.push(p);
        const maxLatency = Math.max(...p.latencies);
        if (maxLatency * 1.5 > this.totalLatency) {
            this.totalLatency = Math.ceil(maxLatency * 1.5);
            console.log("New Orchestra Latency (New Performer): ", Math.ceil(maxLatency * 1.5))
        }
    }

    public removePerformer(p: Performer) {
        let performerIndex = this.performers.map(q => q.id).indexOf(p.id)
        this.performers.splice(performerIndex, 1);
    }

    public updateLatencies(latencies: number[]) {
        const maxLatency = Math.max(...latencies);
        if (maxLatency * 1.5 > this.totalLatency) {
            this.totalLatency = Math.ceil(maxLatency * 1.5);
            console.log("New Orchestra Latency (Update Latencies): ", Math.ceil(maxLatency * 1.5))
        }
    }
}

export default Orchestra;