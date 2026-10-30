import { renderSVG } from "uqr";

export function qrSvg(text: string): string {
  return renderSVG(text, {
    ecc: "M",
    border: 2,
    pixelSize: 4,
    blackColor: "#e8e8e4",
    whiteColor: "#141418",
  });
}
