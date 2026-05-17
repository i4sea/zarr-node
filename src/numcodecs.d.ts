// Ambient stub for the `numcodecs` module. The real package ships its
// types only through an `exports`-map "types" condition, which
// `moduleResolution: node` (classic, used by the CJS build) does not
// honor. Without this stub the CJS tsc run fails with TS2307.
//
// The ESM build's `moduleResolution: NodeNext` reads the real types
// from the package directly; this declaration is shadowed there and
// has no effect on the published .d.ts.
declare module "numcodecs" {
  export const Blosc: {
    fromConfig(config: { id: string; [key: string]: unknown }): {
      id: string;
      decode(data: Uint8Array): Promise<Uint8Array>;
    };
  };
}
