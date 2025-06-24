import { Performer } from "./types.js";

class Orchestra {
    public name: string = "Test";
    public isPlaying: boolean = false;
    public conductor: Performer | null = null;
    public performers: Performer[] = [];
    public tempo: number = 120;
    public baseTime: number = 0;
    public totalLatency: number = 0;
    constructor() { }

    public addPerformer(p: Performer) {
        this.performers.push(p);
        const maxLatency = Math.max(...p.latencies);
        if (maxLatency > this.totalLatency) {
            this.totalLatency = Math.ceil(maxLatency * 1.5);
            console.log("New Latency: ", Math.ceil(maxLatency * 1.5))
        }
    }

    public removePerformer(p: Performer) {
        let performerIndex = this.performers.map(q => q.id).indexOf(p.id)
        this.performers.splice(performerIndex, 1);
        const maxLatency = Math.max(...p.latencies);
        if (maxLatency * 1.5 < this.totalLatency) {
            this.totalLatency = Math.ceil(maxLatency * 1.5);
            console.log("New Latency: ", Math.ceil(maxLatency * 1.5))
        }
    }
}

export default Orchestra;