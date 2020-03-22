import uuid from "uuid/v4";
import Uploader from './uploader';
import Config from './config';
import dcopy from 'deep-copy';
import Cookies from 'js-cookie';
import * as debug from './debugger';
import { parseInt, maxNumber, byteLength, getGlobalUserId, equalArray } from './utils';

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
    "touchend",
    "resize"
];

let pageLoadTime = new Date();

let hiddenProperty = 'hidden' in document ? 'hidden' :
    'webkitHidden' in document ? 'webkitHidden' :
    'mozHidden' in document ? 'mozHidden' :
    null;
let visibilityChangeEvent = hiddenProperty ? hiddenProperty.replace(/hidden/i, 'visibilitychange') : null;

function getButton(btn) {
    if (btn === '2') {
        return 'Right';
    } else {
        return "";
    }
}

function getSessionId() {
    let sessionId = Cookies.get("mouselogSessionId");
    if (!sessionId) {
        sessionId = uuid();
        Cookies.set("mouselogSessionId", sessionId);
    }
    return sessionId;
}

class Mouselog {
    constructor() {
        this.config = new Config();
        this.impressionId = uuid();
        this.mouselogLoadTime = new Date();
        this.uploader = new Uploader();

        this.batchCount = 0; 
        this.packetCount = 0;

        this.eventsList = [];
        this.lastEvtInfo;
        this.eventsCount = 0;
        this.uploadInterval; // For "periodic" upload mode
        this.uploadTimeout; // For "mixed" upload mode
    }

    _clearBuffer() {
        this.eventsList = [];
    }

    _newDataBatch() {
        let trace = {
            batchId: this.batchCount,
            packetId: 0,
            url: window.location.hostname ? window.location.hostname : "localhost",
            path: window.location.pathname,
            width: maxNumber(document.body.scrollWidth, window.innerWidth),
            height: maxNumber(document.body.scrollHeight, window.innerHeight),
            pageLoadTime: pageLoadTime,
            referrer: document.referrer,
            events: []
        };
        this.batchCount += 1;
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
        // (id, event type, timestamp)
        let evtInfo = [this.eventsCount, targetEvents.indexOf(evt.type), Math.floor(evt.timeStamp) / 1000];
        switch (evt.type) {
            case "mousemove": // (x,y)
                let x = parseInt(evt.pageX);
                let y = parseInt(evt.pageY);
                evtInfo.push(x, y);
                break;
            case "touchmove":
            case "touchstart":
            case "touchend":    // (x,y)
                x = parseInt(evt.changedTouches[0].pageX);
                y = parseInt(evt.changedTouches[0].pageY);
                evtInfo.push(x, y);
                break;
            case "wheel": // (x,y,deltaX,deltaY)
                x = parseInt(evt.pageX);
                y = parseInt(evt.pageY);
                let deltaX = parseInt(evt.deltaX);
                let deltaY = parseInt(evt.deltaY);
                evtInfo.push(x, y, deltaX, deltaY);
                break;
            case "mouseup":
            case "mousedown":
            case "click":
            case "dblclick":
            case "contextmenu": // (x,y,button)
                x = parseInt(evt.pageX);
                y = parseInt(evt.pageY);
                let btn = getButton(evt.buttono);
                evtInfo.push(x, y, btn);
                break;
            case "resize": // (width,height)
                let width = evt.target.innerWidth;
                let height = evt.target.innerHeight;
                evtInfo.push(width, height)
                break;
        }

        // Remove Redundant events
        if (this.lastEvtInfo && equalArray(this.lastEvtInfo, evtInfo)) {
            return;
        }
        // Remove two consecutive Mousemove/Touchmove events with the same x and y
        if (this.lastEvtInfo && ["mousemove", "touchmove"].includes(targetEvents[evtInfo[1]]) && this.lastEvtInfo[1] == evtInfo[1] && equalArray(this.lastEvtInfo.slice(3), evtInfo.slice(3))) {
            return;
        }

        this.eventsList.push(evtInfo);
        this.lastEvtInfo = evtInfo;
        this.eventsCount += 1;

        if ( this.config.uploadMode == "event-triggered" && this.eventsList.length % this.config.frequency == 0 ) {
            this._uploadData();
        }

        if ( this.config.uploadMode == "mixed" && this.eventsList.length % this.config.frequency == 0) {
            this._periodUploadTimeout();
            this._uploadData();
        }
    }

    _encodeData(data) {
        let encodedData = JSON.stringify(data);
        if (this.config.encoder.toLowerCase() == "base64") {
            encodedData = btoa(encodedData);
        }
        return encodedData;
    }

    _binarySplitBigDataBlock(dataBlock) {
        let encodedData = this._encodeData(dataBlock);
        let res = [];
        if ( byteLength(encodedData) >= this.config.sizeLimit ) {
            let newDataBlock = dcopy(dataBlock);
            dataBlock.events.splice(dataBlock.events.length / 2);
            newDataBlock.events.splice(0, newDataBlock.events.length / 2);
            this._binarySplitBigDataBlock(dataBlock).forEach(data => {
                res.push(data);
            });
            this._binarySplitBigDataBlock(newDataBlock).forEach(data => {
                res.push(data);
            });

        } else {
            res.push(dataBlock);
        }
        return res;
    }

    _fetchConfigFromServer() {
        // Upload an empty trace to fetch config from server
        let trace = this._newDataBatch();

        trace.packetId = this.packetCount;
        this.packetCount += 1;
        return this.uploader.upload(trace, this._encodeData(trace), true); // This is a promise
    }

    _uploadData() {
        if (this.config.uploadTimes && this.batchCount >= this.config.uploadTimes + this.config.enableServerConfig) {
            return; 
            // TODO: This is only a stopgap method, a better method is to stop mouselog entirely.
        }
        let data = this._newDataBatch();
        data.events = this.eventsList;
        this.eventsList = [];

        let dataList = this._binarySplitBigDataBlock(data); // An array of data blocks
        dataList.forEach(data => {
            data.packetId = this.packetCount;
            this.packetCount += 1;
            let encodedData = this._encodeData(data);
            this.uploader.upload(data, encodedData);
        })
    }

    _periodUploadTimeout() {
        clearTimeout(this.uploadTimeout);
        this.uploadTimeout = setTimeout(() => {
            if (this.eventsList.length > 0) {
                this._uploadData();
            }
        }, this.config.uploadPeriod);
    }

    _periodUploadInterval() {
        clearInterval(this.uploadInterval);
        this.uploadInterval = setInterval(() => {
            if (this.eventsList.length > 0) {
                this._uploadData();
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
        if (this.config.build(config)) {
            // Session ID == "" => localStorage is disabled / Mouselog Session is not enabled
            this.sessionId = this.config.enableSession ? getSessionId() : "";
            this.uploader = new Uploader(this.impressionId, this.sessionId, this.config);
            if (this.config.enableServerConfig) {
                // Async: Upload an empty data to fetch config from server
                this._fetchConfigFromServer().then( result => {
                    if (result.status == 1) {
                        if (this.config.update(result.config)) {
                            this._resetCollector();
                            this.uploader.setConfig(this.config);
                            this.sessionId = this.config.enableSession ? getSessionId() : "";
                            this.uploader.sessionId = this.sessionId;
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
            }
            window.onunload = () => {
                if (this.eventsList.length != 0) {
                    this._uploadData();
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
            debug.write(`Session ID: ${this.sessionId}`);
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
