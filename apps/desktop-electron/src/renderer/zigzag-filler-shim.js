import { ZigZagFiller as BaseZigZagFiller } from "../../node_modules/roughjs/bin/fillers/zigzag-filler.js";

export class ZigZagFiller extends BaseZigZagFiller {
  fillPolygon(points, options) {
    return this.fillPolygons([points], options);
  }
}
