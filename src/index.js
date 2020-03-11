import uuid from "uuid/v4";
import Uploader from './uploader';
import Config from './config';
import dcopy from 'deep-copy';
import * as debug from './debugger';
import { parseInt, maxNumber, byteLength, getGlobalUserId } from './utils';

let targetEvents = [
    "mousemove",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "wheel",
    "touchstart",
    "touchmove",
    "touchend"
];
let pageLoadTime = new Date();

let hiddenProperty = 'hidden' in document ? 'hidden' :
    'webkitHidden' in document ? 'webkitHidden' :
    'mozHidden' in document ? 'mozHidden' :
    null;
let visibilityChangeEvent = hiddenProperty ? hiddenProperty.replace(/hidden/i, 'visibilitychange') : null;

function getRelativeTimestampInSeconds() {
    let diff = new Date() - pageLoadTime;
    return Math.floor(diff) / 1000;
}

function getButton(btn) {
    if (btn === '2') {
        return 'Right';
    } else {
        return "";
    }
}

class Mouselog {
    constructor() {
        this.impressionId = uuid();
        this.config = new Config();
        this.mouselogLoadTime = new Date();
        this.uploader = new Uploader();
        this.eventsList = [];
        this.lastEvent;
        this.eventsCount = 0;
        this.uploadInterval; // For "periodic" upload mode
        this.uploadTimeout; // For "mixed" upload mode
    }

    _clearBuffer() {
        this.eventsList = [];
    }

    _newTrace() {
        let trace = {
            id: '0',
            idx: 0,
            url: window.location.hostname ? window.location.hostname : "localhost",
            path: window.location.pathname,
            width: maxNumber(document.body.scrollWidth, window.innerWidth),
            height: maxNumber(document.body.scrollHeight, window.innerHeight),
            pageLoadTime: pageLoadTime,
            events: []
        };
        return trace;
    }
    _onVisibilityChange() {
        if (window.document[hiddenProperty]) {
            // the page is not activated
            this._pause();
        } else {
            // the page is activated
            this._resume();
        }
    }
    _mouseHandler(evt) {
        // PC's Chrome on Mobile mode can still receive "contextmenu" event with zero X, Y, so we ignore these events.
        if (evt.type === 'contextmenu' && evt.pageX === 0 && evt.pageY === 0) {
            return;
        }

        // In IE, evt.pageX/Y is float
        let x = parseInt(evt.pageX);
        let y = parseInt(evt.pageY);

        // x and y is NaN
        if (x == NaN || x == undefined) {
            // evt.changedTouches[0].pageX/Y is floats
            x = parseInt(evt.changedTouches[0].pageX);
            y = parseInt(evt.changedTouches[0].pageY);
        }
        let tmpEvt = {
            id: this.eventsCount, 
            timestamp: getRelativeTimestampInSeconds(),
            type: evt.type,
            x: x,
            y: y,
            button: getButton(evt.button)
        };

        if (evt.type == "wheel") {
            tmpEvt.deltaX = evt.deltaX;
            tmpEvt.deltaY = evt.deltaY;
        }

        // Evaluate if `tmpEvt` is the same as the previous events
        // If true, drop `tmpEvt`
        if (this.lastEvent && this.lastEvent.timestamp == tmpEvt.timestamp 
            && this.lastEvent.x == tmpEvt.x && this.lastEvent.y == tmpEvt.y
            && this.lastEvent.type == tmpEvt.type && this.lastEvent.button == tmpEvt.button) {
            return;
        }
        
        this.eventsList.push(tmpEvt);
        this.lastEvent = tmpEvt;
        this.eventsCount += 1;

        if ( this.config.uploadMode == "event-triggered" && this.eventsList.length % this.config.frequency == 0 ) {
            this._uploadTrace();
        }

        if ( this.config.uploadMode == "mixed" && this.eventsList.length % this.config.frequency == 0) {
            this._periodUploadTimeout();
            this._uploadTrace();
        }
    }

    _binarySplitBigDataBlock(dataBlock) {
        let encodedData = JSON.stringify(dataBlock);
        let res = [];
        if ( byteLength(encodedData) >= this.config.sizeLimit ) {
            let newDataBlock = dcopy(dataBlock);
            dataBlock.events.splice(dataBlock.events.length / 2);
            newDataBlock.events.splice(0, newDataBlock.events.length / 2);
            this._binarySplitBigDataBlock(dataBlock).forEach(block => {
                res.push(block);
            });
            this._binarySplitBigDataBlock(newDataBlock).forEach(block => {
                res.push(block);
            });
            
        } else {
            res.push(dataBlock);
        }
        return res;
    }

    _fetchConfigFromServer() {
        // Upload an empty trace to fetch config from server
        let trace = this._newTrace();
        trace.idx = this.uploadIdx;
        this.uploadIdx += 1;
        return this.uploader.upload(trace, JSON.stringify(trace)); // This is a promise
    }

    _uploadTrace() {
        let trace = this._newTrace();
        trace.events = this.eventsList;
        this.eventsList = [];
        let dataBlocks = this._binarySplitBigDataBlock(trace); // An array of data blocks
        dataBlocks.forEach( dataBlock => {
            dataBlock.idx = this.uploadIdx;
            this.uploadIdx += 1;
            let encodedData = JSON.stringify(dataBlock);
            this.uploader.upload(dataBlock, encodedData); // This is a promise
        });
    }

    _periodUploadTimeout() {
        clearTimeout(this.uploadTimeout);
        this.uploadTimeout = setTimeout(() => {
            if (this.eventsList.length > 0) {
                this._uploadTrace();
            }
        }, this.config.uploadPeriod);
    }

    _periodUploadInterval() {
        clearInterval(this.uploadInterval);
        this.uploadInterval = setInterval(() => {
            if (this.eventsList.length > 0) {
                this._uploadTrace();
            }
        }, this.config.uploadPeriod);
    }

    _runCollector() {
        targetEvents.forEach( s => {
            this.config.scope.addEventListener(s, (evt) => this._mouseHandler(evt));
        });

        if (this.config.uploadMode === "periodic") {
            this._periodUploadInterval();
        }

        if (this.config.uploadMode === "mixed") {
            this._periodUploadTimeout();
        }
    }

    _stopCollector() {
        targetEvents.forEach( s => {
            this.config.scope.removeEventListener(s, (evt) => this._mouseHandler(evt));
        });
        clearInterval(this.uploadInterval);
        clearTimeout(this.uploadTimeout);
    }

    _resetCollector() {
        this._stopCollector();
        this._runCollector();
    }

    _init(config) {
        this._clearBuffer();
        this.uploadIdx = 0;
        this.uploader = new Uploader(this.config);
        this.uploader.setImpressionId(this.impressionId);
        if (this.config.build(config)) {
             // Async: Upload an empty data to fetch config from server
             this._fetchConfigFromServer().then( result => {
                 if (result.status == 1) {
                     if (this.config.update(result.config)) {
                         this._resetCollector();
                         this.uploader.setConfig(this.config);
                         debug.write("Successfully update config from backend.");
                     } else {
                        throw new Error(`Unable to update config with server config.`);
                     }
                 } else {
                    throw new Error(`Fail to get config from server.`);
                 }
             }).catch(err => {
                 debug.write(err);
             });
            window.onunload = () => {
                if (this.eventsList.length != 0) {
                    this._uploadTrace();
                }
            };
            return {status: 0};
        } else {
            return {status: -1, msg: `Invalid configuration.`};
        }
    }

    _pause() {
        this._stopCollector();
    }

    _resume() {
        this._runCollector();
    }

    run(config) {
        let res = this._init(config);
        if (res.status == 0) {
            if (visibilityChangeEvent) {
                document.addEventListener(visibilityChangeEvent, (evt)=>this._onVisibilityChange(evt));
            }
            this._runCollector();
            this.uploader.start(this.impressionId);
            debug.write("Mouselog agent is activated!");
            debug.write(`Website ID: ${this.config.websiteId}`);
            debug.write(`Impression ID: ${this.impressionId}`);
            debug.write(`User-Agent: ${navigator.userAgent}`);
            debug.write(`User ID: ${getGlobalUserId()}`);
            debug.write(`Page load time: ${pageLoadTime}`);
        } else {
            debug.write(res.msg);
            debug.write("Fail to initialize Mouselog agent.");
        }
    }

    debug(config, debugOutputElementId) {
        debug.activate(debugOutputElementId);
        this.run(config);
    }

    stop() {
        this.uploader.stop();
        this._stopCollector();
        this._clearBuffer();
        debug.write(`Mouselog agent ${this.impressionId} is stopped!`);
    }
}

export default Mouselog;
