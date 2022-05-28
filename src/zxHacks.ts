// This is a * import so TS doesn't drop the import because it thinks
// ProcessPromise is a value. (zx's type definitions are wrong; ProcessPromise is a class)
import * as zx from "zx";

// Tremendously terrible hack to make xz print only the commands and not their outputs.
// Please, look away. (This is only validated to work in zx 6.1.0)
// Soon: https://github.com/google/zx/issues/306
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
Object.defineProperty(zx.ProcessPromise.prototype, "_run", {
    configurable: true,
    enumerable: true,
    get: function () {
        return this.__run;
    },
    set: function (run) {
        this.__run = run;

        let _quiet: boolean = this._quiet;

        Object.defineProperty(this, "_quiet", {
            configurable: true,
            enumerable: true,
            get: function () {
                if (_quiet) {
                    return true;
                }

                if (this.__hideOutput ?? defaultHideOutput) {
                    _quiet = true;
                }

                return false;
            },
            set: function (quiet) {
                _quiet = quiet;
            },
        });
    },
});

let defaultHideOutput = false;

export function setHideOutput(hideOutput: boolean) {
    defaultHideOutput = hideOutput;
}

export function hideOutput(p: zx.ProcessPromise<zx.ProcessOutput>) {
    (p as any).__hideOutput = true;
    return p;
}

export function showOutput(p: zx.ProcessPromise<zx.ProcessOutput>) {
    (p as any).__hideOutput = false;
    return p;
}
