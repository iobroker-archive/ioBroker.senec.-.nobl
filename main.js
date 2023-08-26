'use strict';
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // not cool, not nice - but well ... just a last option if everything else fails

const https = require('https');
const agent = new https.Agent({ 
	requestCert: true,
	rejectUnauthorized: false 
});

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const state_attr = require(__dirname + '/lib/state_attr.js');
const state_trans = require(__dirname + '/lib/state_trans.js');

let retry = 0; // retry-counter
let retryLowPrio = 0; // retry-counter
let connectVia = "http://";

const allKnownObjects = new Set(["STATISTIC","ENERGY","FEATURES","LOG","SYS_UPDATE","WIZARD","BMS","BAT1","BAT1OBJ1","BAT1OBJ2","BAT1OBJ3","BAT1OBJ4","PWR_UNIT","PM1OBJ1","PM1OBJ2","PV1","FACTORY","GRIDCONFIG","EG_CONTROL","RTC","PM1","TEMPMEASURE","DEBUG","SOCKETS","CASC","WALLBOX","CONNX50","STECA"]);
const highPrioObjects = new Map;
let lowPrioForm = "";
let highPrioForm = "";

let unloaded = false;

const knownObjects = {};

class Senec extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'senec',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);
        try {
			await this.initPollSettings();
            await this.checkConfig();
            await this.checkConnection();
			await this.pollSenec(true, 0); // highPrio
			await this.pollSenec(false, 0); // lowPrio
        } catch (error) {
            this.log.error(error);
            this.setState('info.connection', false, true);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
			unloaded = true;
            if (this.timer) {
                clearTimeout(this.timer);
            }
            if (this.timerLowPrio) {
                clearTimeout(this.timerLowPrio);
            }
            this.log.info('cleaned everything up...');
            this.setState('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }
	
	async initPollSettings() {
		// creating form for low priority pulling (which means pulling everything we know)
		// we can do this while preparing values for high prio
		lowPrioForm = '{';	
		allKnownObjects.forEach (function(value) {
			lowPrioForm += '"' + value + '":{},';
			const objectsSet = new Set();
			switch (value) {
				case "BMS":
					["CELL_TEMPERATURES_MODULE_A","CELL_TEMPERATURES_MODULE_B","CELL_TEMPERATURES_MODULE_C","CELL_TEMPERATURES_MODULE_D","CELL_VOLTAGES_MODULE_A","CELL_VOLTAGES_MODULE_B","CELL_VOLTAGES_MODULE_C","CELL_VOLTAGES_MODULE_D","CURRENT","SOC","SYSTEM_SOC","TEMP_MAX","TEMP_MIN","VOLTAGE"].forEach(item => objectsSet.add(item));
				break;
				case "ENERGY":
					["STAT_STATE","GUI_BAT_DATA_POWER","GUI_INVERTER_POWER","GUI_HOUSE_POW","GUI_GRID_POW","GUI_BAT_DATA_FUEL_CHARGE","GUI_CHARGING_INFO","GUI_BOOSTING_INFO","GUI_BAT_DATA_POWER","GUI_BAT_DATA_VOLTAGE","GUI_BAT_DATA_CURRENT","GUI_BAT_DATA_FUEL_CHARGE","GUI_BAT_DATA_OA_CHARGING","STAT_LIMITED_NET_SKEW"].forEach(item => objectsSet.add(item));
				break;
				case "PV1":
					["POWER_RATIO","MPP_POWER"].forEach(item => objectsSet.add(item));
				break;
				case "PWR_UNIT":
					["POWER_L1","POWER_L2","POWER_L3"].forEach(item => objectsSet.add(item));
				break;
				case "PM1OBJ1":
					["FREQ","U_AC","I_AC","P_AC","P_TOTAL"].forEach(item => objectsSet.add(item));
				break;
				case "PM1OBJ2":
					["FREQ","U_AC","I_AC","P_AC","P_TOTAL"].forEach(item => objectsSet.add(item));
				break;
				case "STATISTIC":
					["LIVE_GRID_EXPORT","LIVE_GRID_IMPORT","LIVE_HOUSE_CONS","LIVE_PV_GEN","LIVE_BAT_CHARGE_MASTER","LIVE_BAT_DISCHARGE_MASTER"].forEach(item => objectsSet.add(item));
				break;
				case "WALLBOX":
					["APPARENT_CHARGING_POWER","PROHIBIT_USAGE","EV_CONNECTED","STATE"].forEach(item => objectsSet.add(item));
				break;
				default:
					// nothing to do here
				break;
			}
			if (objectsSet.size > 0) {
				highPrioObjects.set(value, objectsSet);
			}
		})
		
		lowPrioForm = lowPrioForm.slice(0, -1) +  '}';
		this.log.info("(initPollSettings) lowPrio: " + lowPrioForm);
		
		// creating form for high priority pulling
		highPrioForm = '{';
		highPrioObjects.forEach( function (mapValue, key, map) {
			highPrioForm += '"' + key + '":{';
			mapValue.forEach (function (setValue) {
				highPrioForm += '"' + setValue + '":"",';
			})
			highPrioForm = highPrioForm.slice(0, -1) +  '},';
		})
		highPrioForm = highPrioForm.slice(0, -1) +  '}';

		this.log.info("(initPollSettings) highPrio: " + highPrioForm);
		
	}

    /**
     * checks config paramaters
     * Fallback to default values in case they are out of scope
     */
    async checkConfig() {
        this.log.debug("(checkConf) Configured polling interval high priority: " + this.config.interval);
        if (this.config.interval < 1 || this.config.interval > 3600) {
            this.log.warn("(checkConf) Config interval high priority " + this.config.interval + " not [1..3600] seconds. Using default: 10");
            this.config.interval = 10;
        }
        this.log.debug("(checkConf) Configured polling interval low priority: " + this.config.intervalLow);
        if (this.config.intervalLow < 10 || this.config.intervalLow > 3600) {
            this.log.warn("(checkConf) Config interval low priority " + this.config.intervalLow + " not [10..3600] minutes. Using default: 60");
            this.config.intervalLow = 60;
        }
        this.log.debug("(checkConf) Configured polling timeout: " + this.config.pollingTimeout);
        if (this.config.pollingTimeout < 1000 || this.config.pollingTimeout > 10000) {
            this.log.warn("(checkConf) Config timeout " + this.config.pollingTimeout + " not [1000..10000] ms. Using default: 5000");
            this.config.pollingTimeout = 5000;
        }
        this.log.debug("(checkConf) Configured num of retries: " + this.config.retries);
        if (this.config.retries < 0 || this.config.retries > 999) {
            this.log.warn("(checkConf) Config num of retries " + this.config.retries + " not [0..999] seconds. Using default: 10");
            this.config.retries = 10;
        }
        this.log.debug("(checkConf) Configured retry multiplier: " + this.config.retrymultiplier);
        if (this.config.retrymultiplier < 1 || this.config.retrymultiplier > 10) {
            this.log.warn("(checkConf) Config retry multiplier " + this.config.retrymultiplier + " not [1..10] seconds. Using default: 2");
            this.config.retrymultiplier = 2;
        }
		this.log.debug("(checkConf) Configured https-usage: " + this.config.useHttps);
		if (this.config.useHttps) {
			connectVia = "https://";
			this.log.debug("(checkConf) Switching to https ... " + this.config.useHttps);
		}
    }

    /**
     * checks connection to senec service
     */
    async checkConnection() {
        const url = connectVia + this.config.senecip + '/lala.cgi';
        const form = '{"ENERGY":{"STAT_STATE":""}}';
        try {
            this.log.info('connecting to Senec: ' + url);
            const body = await this.doGet(url, form, this, this.config.pollingTimeout);
            this.log.info('connected to Senec: ' + url);
            this.setState('info.connection', true, true);
        } catch (error) {
            throw new Error("Error connecting to Senec (IP: " + connectVia + this.config.senecip + "). Exiting! (" + error + "). Try to toggle https-mode in settings and check FQDN of SENEC appliance.");
        }
    }

    /**
     * Read from url via axios
     * @param url to read from
     * @param form to post
     */
	doGet(pUrl, pForm, caller, pollingTimeout) {
		return new Promise(function (resolve, reject) {
			axios({
				method: 'post',
				httpsAgent: agent,
				url: pUrl,
				data: pForm,
				timeout: pollingTimeout
			})
			.then(
				async (response) => {
                        const content = response.data;
                        caller.log.debug('(Poll) received data (' + response.status + '): ' + JSON.stringify(content));
						resolve(JSON.stringify(content));
                    }
                )
			.catch(
				(error) => {
					if (error.response) {
						// The request was made and the server responded with a status code
						caller.log.warn('(Poll) received error ' + error.response.status + ' response from SENEC with content: ' + JSON.stringify(error.response.data));
						reject(error.response.status);
					} else if (error.request) {
						// The request was made but no response was received
						// `error.request` is an instance of XMLHttpRequest in the browser and an instance of http.ClientRequest in node.js<div></div>
						caller.log.info(error.message);
						reject(error.message);
					} else {
						// Something happened in setting up the request that triggered an Error
						caller.log.info(error.message);
						reject(error.status);
					}
				}
			);
		});
	}
	
	/**
     * Read values from Senec Home V2.1
	 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often. Adverse effects: No sync with Senec possible if called too often.
     */
	async pollSenec(isHighPrio, retry) {
		const url = connectVia + this.config.senecip + '/lala.cgi';	
		var interval = this.config.interval * 1000;
		if (!isHighPrio) { 
			this.log.info('LowPrio polling ...');
			interval = this.config.intervalLow * 1000 * 60
		}
		
		try {
            var body = await this.doGet(url, (isHighPrio ? highPrioForm : lowPrioForm), this, this.config.pollingTimeout);
			if (body.includes('\\"')) { 
				// in rare cases senec reports back extra escape sequences on some machines ...
				this.log.info("(Poll) Double escapes detected!  Body inc: " + body);
				body = body.replace(/\\"/g, '"');
				this.log.info("(Poll) Double escapes autofixed! Body out: " + body);
			}
            var obj = JSON.parse(body, reviverNumParse);
            await this.evalPoll(obj);

            retry = 0;
			if (unloaded) return;
            this.timer = setTimeout(() => this.pollSenec(isHighPrio, retry), interval);
        } catch (error) {
            if ((retry == this.config.retries) && this.config.retries < 999) {
                this.log.error("Error reading from Senec " + (isHighPrio ? "high" : "low") + "Prio (" + this.config.senecip + "). Retried " + retry + " times. Giving up now. Check config and restart adapter. (" + error + ")");
                this.setState('info.connection', false, true);
            } else {
                retry += 1;
                this.log.warn("Error reading from Senec " + (isHighPrio ? "high" : "low") + "Prio (" + this.config.senecip + "). Retry " + retry + "/" + this.config.retries + " in " + (interval * this.config.retrymultiplier * retry) / 1000 + " seconds! (" + error + ")");
                this.timer = setTimeout(() => this.pollSenec(isHighPrio, retry), interval * this.config.retrymultiplier * retry);
            }
        }
		
	}

    /**
     * sets a state's value and creates the state if it doesn't exist yet
     */
    async doState(name, value, description, unit, write) {
		if (!isNaN(name.substring(0, 1))) {
			// keys cannot start with digits! Possibly SENEC delivering erraneous data
			this.log.debug('(doState) Invalid datapoint: ' + name + ': ' + value);
			return;
		}
		this.log.silly('(doState) Update: ' + name + ': ' + value);
       
		const valueType = value !== null && value !== undefined ? typeof value : "mixed";
	
		// Check object for changes:
		const obj = knownObjects[name] ? knownObjects[name] : await this.getObjectAsync(name);
		if (obj) {
			const newCommon = {};
			if (obj.common.name !== description) {
				this.log.debug("(doState) Updating object: " + name + " (desc): " + obj.common.name + " -> " + description);
				newCommon.name = description;
			}
			if (obj.common.type !== valueType) {
				this.log.debug("(doState) Updating object: " + name + " (type): " + obj.common.type + " -> " + typeof value);
				newCommon.type = valueType;
			}
			if (obj.common.unit !== unit) {
				this.log.debug("(doState) Updating object: " + name + " (unit): " + obj.common.unit + " -> " + unit);
				newCommon.unit = unit;
			}
			if (obj.common.write !== write) {
				this.log.debug("(doState) Updating object: " + name + " (write): " + obj.common.write + " -> " + write);
				newCommon.write = write;
			}
			if (Object.keys(newCommon).length > 0) {
				await this.extendObjectAsync(name, { common: newCommon });
			}
		} else {
			knownObjects[name] = {
				type: "state",
				common: {
					name: description,
					type: valueType,
					role: "value",
					unit: unit,
					read: true,
					write: write
				},
				native: {}
			};
			await this.setObjectNotExistsAsync(name, knownObjects[name]);
		}
		await this.setStateChangedAsync(name, {
			val: value,
			ack: true
		});
		await this.checkUpdateSelfStat(name);
		await this.doDecode(name, value);
	}
		
	/**
	 * Checks if there is decoding possible for a given value and creates/updates a decoded state
	 * Language used for translations is the language of the SENEC appliance
	 */
	async doDecode(name, value) {
		// Lang: WIZARD.GUI_LANG 0=German, 1=English, 2=Italian
		var lang = 1; // fallback to english
		var langState = await this.getStateAsync('WIZARD.GUI_LANG');
		if (langState) lang = langState.val;
		this.log.silly("(Decode) Senec language: " + lang);
		var key = name;
		if (!isNaN(name.substring(name.lastIndexOf('.')) + 1)) key = name.substring(0, name.lastIndexOf('.'));
		this.log.silly("(Decode) Checking: " + name + " -> " + key);
		
		if (state_trans[key + "." + lang] !== undefined) {
			this.log.silly("(Decode) Trans found for: " + key + "." + lang);
			const trans = (state_trans[key + "." + lang] !== undefined ? (state_trans[key + "." + lang][value] !== undefined ? state_trans[key + "." + lang][value] : "(unknown)") : "(unknown)");
			this.log.silly("(Decode) Trans " + key + ":" + value + " = " + trans);
			const desc = (state_attr[key + "_Text"] !== undefined) ? state_attr[key + "_Text"].name : key;
			await this.doState(name + "_Text", trans, desc, "", true);
		}
	}

	/** 
	 * Helper routine
	 */
	async checkUpdateSelfStat(name) {
		if (name === "STATISTIC.LIVE_GRID_EXPORT" || name === "STATISTIC.LIVE_GRID_IMPORT" || name === "STATISTIC.LIVE_HOUSE_CONS" || name === "STATISTIC.LIVE_PV_GEN" || name === "STATISTIC.LIVE_BAT_CHARGE_MASTER" || name === "STATISTIC.LIVE_BAT_DISCHARGE_MASTER") {
			await this.updateSelfStat(name);
		}
	}
	
	/**
	 * evaluates data polled from SENEC system.
	 * creates / updates the state.
	 */
    async evalPoll(obj) {
		if (unloaded) return;
        for (const[key1, value1] of Object.entries(obj)) {
            for (const[key2, value2] of Object.entries(value1)) {
                if (value2 !== "VARIABLE_NOT_FOUND" && key2 !== "OBJECT_NOT_FOUND") {
                    const key = key1 + '.' + key2;
                    if (state_attr[key] === undefined) {
                        this.log.info('REPORT_TO_DEV: State attribute definition missing for: ' + key + ', Val: ' + value2);
                    }	
                    const desc = (state_attr[key] !== undefined) ? state_attr[key].name : key2;
                    const unit = (state_attr[key] !== undefined) ? state_attr[key].unit : "";

                    if (Array.isArray(value2)) {
                        for (var i = 0; i < value2.length; i++) {
                            this.doState(key + '.' + i, ValueTyping(key, value2[i]), desc + '[' + i + ']', unit, false);
                        }
                    } else {
                        this.doState(key, ValueTyping(key, value2), desc, unit, false);
                    }
                }
            }
        }
    }
	
	async updateSelfStat(name, value) {
		await this.updateSelfStatHelper(name, value, ".today", ".yesterday", ".refValue", "Day", getCurDay());
		await this.updateSelfStatHelper(name, value, ".week", ".lastWeek", ".refValueWeek", "Week", getCurWeek());
		await this.updateSelfStatHelper(name, value, ".month", ".lastMonth", ".refValueMonth", "Month", getCurMonth());
		await this.updateSelfStatHelper(name, value, ".year", ".lastYear", ".refValueYear", "Year", getCurYear());
		return;		
	}
	
	async updateSelfStatHelper(name, value, today, yesterday, refValue, day, curDay) {
		const key = "_calc." + name.substring(10);
		
		const refDayObj = await this.getStateAsync(key + ".ref" + day);
		const refDay = refDayObj ? refDayObj.val : -1;
		
		const valCurObj = await this.getStateAsync(name);
		const valCur = valCurObj ? valCurObj.val : 0;
		
		const valRefObj = await this.getStateAsync(key + refValue);
		const valRef = valRefObj ? valRefObj.val : 0;
		const valTodayObj = await this.getStateAsync(key + today);
		const valToday = valTodayObj ? valTodayObj.val : 0;
		
		const descToday = (state_attr[key + today] !== undefined) ? state_attr[key + today].name : key;
        const unitToday = (state_attr[key + today] !== undefined) ? state_attr[key + today].unit : "";
		const descYesterday = (state_attr[key + yesterday] !== undefined) ? state_attr[key + yesterday].name : key;
        const unitYesterday = (state_attr[key + yesterday] !== undefined) ? state_attr[key + yesterday].unit : "";
		const descRef = (state_attr[key + refValue] !== undefined) ? state_attr[key + refValue].name : key;
        const unitRef = (state_attr[key + refValue] !== undefined) ? state_attr[key + refValue].unit : "";
		const descRefDay = (state_attr[key + ".ref" + day] !== undefined) ? state_attr[key + ".ref" + day].name : key;
        const unitRefDay = (state_attr[key + ".ref" + day] !== undefined) ? state_attr[key + ".ref" + day].unit : "";
		
		if (refDay != curDay) {
			this.log.debug("(Calc) New " + day + " (or first value seen). Updating stat data for: " + name.substring(10));
			// Change of day
			await this.doState(key + ".ref" + day, curDay, descRefDay, unitRefDay, false);
			await this.doState(key + yesterday, valToday, descYesterday, unitYesterday, false);
			await this.doState(key + today, 0, descToday, unitToday, false);
			if (valRef < valCur) {
				await this.doState(key + refValue, valCur, descRef, unitRef, true);
			} else {
				this.log.warn("(Calc) Not updating reference value for: " + name.substring(10) + "! Old RefValue (" + valRef + ") >= new RefValue (" + valCur + "). Impossible situation. If this is intentional, please update via admin!");
			}
		} else {
			this.log.debug("(Calc) Updating " + day +" value for: " + name.substring(10) + ": " + Number((valCur - valRef).toFixed(2)));
			// update today's value
			await this.doState(key + today, Number((valCur - valRef).toFixed(2)), descToday, unitToday, false);
		}
		
		if (name === "STATISTIC.LIVE_HOUSE_CONS") await this.updateAutarkyHelper(today, yesterday, day, curDay); // otherwise we get way too many updates

	}
	
	async updateAutarkyHelper(today, yesterday, day, curDay) {
		const key = "_calc.Autarky";
		
		// reference object to decide on change of day
		const refDayObj = await this.getStateAsync(key + ".ref" + day);
		const refDay = refDayObj ? refDayObj.val : -1;
		// current day's value (needed in case of day-change)
		const valTodayObj = await this.getStateAsync(key + today);
		const valToday = valTodayObj ? valTodayObj.val : 0;
		
		// reading values required for calc
		const valBatChargeObj = await this.getStateAsync("_calc.LIVE_BAT_CHARGE_MASTER" + today);
		const valBatCharge = valBatChargeObj ? valBatChargeObj.val : 0;
		const valBatDischargeObj = await this.getStateAsync("_calc.LIVE_BAT_DISCHARGE_MASTER" + today);
		const valBatDischarge = valBatDischargeObj ? valBatDischargeObj.val : 0;
		const valGridExpObj = await this.getStateAsync("_calc.LIVE_GRID_EXPORT" + today);
		const valGridExp = valGridExpObj ? valGridExpObj.val : 0;
		const valGridImpObj = await this.getStateAsync("_calc.LIVE_GRID_IMPORT" + today);
		const valGridImp = valGridImpObj ? valGridImpObj.val : 0;
		const valHouseConsObj = await this.getStateAsync("_calc.LIVE_HOUSE_CONS" + today);
		const valHouseCons = valHouseConsObj ? valHouseConsObj.val : 1;
		const valPVGenObj = await this.getStateAsync("_calc.LIVE_PV_GEN" + today);
		const valPVGen = valPVGenObj ? valPVGenObj.val : 0;
			
		const descToday = (state_attr[key + today] !== undefined) ? state_attr[key + today].name : key;
        const unitToday = (state_attr[key + today] !== undefined) ? state_attr[key + today].unit : "%";
		const descYesterday = (state_attr[key + yesterday] !== undefined) ? state_attr[key + yesterday].name : key;
        const unitYesterday = (state_attr[key + yesterday] !== undefined) ? state_attr[key + yesterday].unit : "%";
		const descRefDay = (state_attr[key + ".ref" + day] !== undefined) ? state_attr[key + ".ref" + day].name : key;
        const unitRefDay = (state_attr[key + ".ref" + day] !== undefined) ? state_attr[key + ".ref" + day].unit : "";
		
		if (refDay != curDay) {
			this.log.debug("(Autarky) New " + day + " (or first value seen). Updating Autarky data for: " + key + " " + day);
			// Change of day
			await this.doState(key + ".ref" + day, curDay, descRefDay, unitRefDay, false);
			await this.doState(key + yesterday, valToday, descYesterday, unitYesterday, false);
			// await this.doState(key + today, 0, descToday, unitToday, false); // we don't need to reset autarky to 0 because it is calculated by reference values.
			// instead do the regular calc right after the change of day
		}
		// update today's value - but beware of div/0
		var newVal = 0;
		if (valHouseCons > 0) {
			newVal = Number((((valPVGen - valGridExp - valBatCharge + valBatDischarge) / valHouseCons) * 100).toFixed(0));
			this.log.debug("(Autarky) Updating Autarky " + day +" value for: " + key + today + ": " + newVal);
			await this.doState(key + today, newVal, descToday, unitToday, false);
		}
	}

}

/**
 * modifies the supplied value based upon flags set for the specific key.
 * currently handles bool, date, ip objects
 */
const ValueTyping = (key, value) => {
	if (!isNaN(value)) value = Number(value); // otherwise iobroker will note it as string
    if (state_attr[key] === undefined) {
        return value;
    }
	const isBool = (state_attr[key] !== undefined && state_attr[key].booltype) ? state_attr[key].booltype : false;
	const isDate = (state_attr[key] !== undefined && state_attr[key].datetype) ? state_attr[key].datetype : false;
	const isIP = (state_attr[key] !== undefined && state_attr[key].iptype) ? state_attr[key].iptype : false;
	const multiply = (state_attr[key] !== undefined && state_attr[key].multiply) ? state_attr[key].multiply : 1;
    if (isBool) {
        return (value === 0) ? false : true;
    } else if (isDate) {
        return new Date(value * 1000).toString();
    } else if (isIP) {
        return DecToIP(value);
    } else if (multiply !== 1) {
        return parseFloat((value * multiply).toFixed(2));
    } else {
        return value;
    }
}

/**
 * Converts float value in hex format to js float32.
 * Also fixes to 2 decimals.
 * @param string with hex value
 */
const HexToFloat32 = (str) => {
    var int = parseInt(str, 16);
    if (int > 0 || int < 0) {
        // var sign = (int >>> 31) ? -1 : 1;
        var sign = (int & 0x80000000) ? -1 : 1;
        var exp = (int >>> 23 & 0xff) - 127;
        var mantissa = ((int & 0x7fffff) + 0x800000).toString(2);
        var float32 = 0;
        for (var i = 0; i < mantissa.length; i++) {
            float32 += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
            exp--;
        }
        return (float32 * sign).toFixed(2);
    } else {
        return 0;
    }
}

/**
 * Converts a given decimal to a properly formatted IP address.
 * We have to do that because Senec stores IPs as regular hex values and due to the fact that we
 * are using a reviver function for the JSON we have to back-convert to hex and then build the IP
 * for proper human reading.
 */
const DecToIP = (str) => {
    var ipHex = str.toString(16);
    while (ipHex.length < 8) {
        ipHex = '0' + ipHex;
    }
    const fourth = ipHex.substring(0, 2);
    const third = ipHex.substring(2, 4);
    const second = ipHex.substring(4, 6);
    const first = ipHex.substring(6);
    return (parseInt(first, 16) + '.' + parseInt(second, 16) + '.' + parseInt(third, 16) + '.' + parseInt(fourth, 16));
}

/**
 * Reviver function to convert numeric values to float or int.
 * Senec supplies them as hex.
 * @param key value pair as defined in reviver option
 */
const reviverNumParse = (key, value) => {
    // prepare values for output using reviver function
    if (typeof value === "string") {
        if (value.startsWith("fl_")) { // float in hex IEEE754
            return HexToFloat32(value.substring(3));
        } else if (value.startsWith("u")) { // unsigned int in hex
            return parseInt(value.substring(3), 16);
        } else if (value.startsWith("st_")) { // string?
            return value.substring(3);
        } else if (value.startsWith("i1")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((val & 0x8000) > 0) {
                    val = val - 0x10000;
                }
                return val;
            } else
                return 0;

        } else if (value.startsWith("i3")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((Math.abs(value & 0x80000000)) > 0) {
                    val = val - 0x100000000;
                }
                return val;
            } else
                return 0;

        } else if (value.startsWith("i8")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((value & 0x80) > 0) {
                    val = val - 0x100;
                }
                return val;
            } else
                return 0;
        } else if (value.startsWith("VARIABLE_NOT_FOUND")) {
            return "VARIABLE_NOT_FOUND";
		} else if (value.startsWith("FILE_VARIABLE_NOT_READABLE")) {
            return "";
        } else {
            return "REPORT TO DEV: " + key + ":" + value;
            //throw new Error("Unknown value in JSON: " + key + ":" + value);
        }
    } else {
        return value;
    }
}

/**
 * Returns the current day of the year
 */
const getCurDay = () => {
	return (Math.round((new Date().setHours(23) - new Date(new Date().getYear()+1900, 0, 1, 0, 0, 0))/1000/60/60/24));
}

/**
 * Returns the current month of the year
 */
const getCurMonth = () => {
	return (new Date().getMonth());
}

/**
 * Returns the current year
 */
const getCurYear = () => {
	return (new Date().getFullYear());
}

/**
 * Returns the current week of the year
 * Using Standard ISO8601
 */
const getCurWeek = () => {
	var tdt = new Date();
    var dayn = (tdt.getDay() + 6) % 7;
    tdt.setDate(tdt.getDate() - dayn + 3);
    var firstThursday = tdt.valueOf();
    tdt.setMonth(0, 1);
    if (tdt.getDay() !== 4) {
		tdt.setMonth(0, 1 + ((4 - tdt.getDay()) + 7) % 7);
    }
    return 1 + Math.ceil((firstThursday - tdt) / 604800000);
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Senec(options);
} else {
    // otherwise start the instance directly
    new Senec();
}
