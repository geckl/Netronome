import { Performer } from "./types.js";

class Orchestra{
    public name: string = "Test";
    public isPlaying: boolean = false;
    public conductor: Performer | null = null;
    public performers: Performer[] = [];
    public tempo: number = 120;
    public baseTime: number = 0;
    public totalLatency: number = 0;
    constructor(){}

    public addPerformer(p: Performer){
        this.performers.push(p);
        const maxLatency = Math.max(...p.latencies);
        if(Math.max(maxLatency) > this.totalLatency) {
            this.totalLatency = maxLatency * 1.5;
        }
    }
}

export default Orchestra;