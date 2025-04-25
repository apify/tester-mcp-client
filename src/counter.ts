export class Counter {
    private count: number;

    constructor(value = 0) {
        this.count = value;
    }

    /**
    * Increments the counter by 1
    * @returns incremented value of counter
    */
    increment(): number {
        return ++this.count;
    }
}
