/** 
 * @fileoverview Code sample for demonstrating Cloud-to-Cloud integration with SAP IoT Service.
 *
 * The cloud service of Geotab.com is the data source. The code uses a Geotab-specific
 * API, and the credentials for both Geotab and SAP IoT Service are necessary to run it.
 * They must be put into the config.json file.
 *
 * The code is written in ECMAScript 8, which is supported by recent versions of Node.js.
 * It polls the Geotab REST API constantly and POSTs the new data to the SAP IoT Service
 * as soon as the data becomes available. The code is thus not supposed to run in a Web
 * browser.
 *
 * Asynchronous functions (co-routines) are used intensively. Data of different types
 * are fetched from the Geotab API and POSTed to the SAP IoT API independently of each other. 
 * The data of a single type from a single device a posted sequentially to preserve their
 * order and limit the load on the servers.
 *
 * @author Mikhail Bessonov <mikhail.bessonov@sap.com>
 * @license ?
 */

// Imports

// Native Node.js modules
const fs = require('fs');
const path = require('path');
const storage = require('node-persist');

// Generic third-party modules
const Swagger = require('swagger-client');

// Geotab modules
const Geotab_API = require('mg-api-node');

// SAP modules
const SAP_IoT_device_REST = require('../sap-iots-device-rest');


// Constants

// Delay in ms between Geotab polling requests returning no data
const POLLING_DELAY_MS = 1000;
// The limit on the number of polling iterations. Should be set to 0 in production.
const DEBUG_ITERATIONS_LIMIT = 20;
// The maximum number of records to fetch from a Geotab database per poll request.
const MAX_RECORDS_PER_ITERATION = 100;

/** 
 * Data types known by SAP IoT Service.
 * @enum {string}
 */
const DATATYPE = {
    integer: 'integer', 
    long: 'long', 
    float: 'float', 
    double: 'double',
    boolean: 'boolean', 
    string: 'string', 
    binary: 'binary', 
    date: 'date'
}

// Read the configuration file.
const config = readConfigFile('config.json');

/** Geotab API */
const geotab = new Geotab_API(config.Geotab_username, config.Geotab_password, config.Geotab_database);

/** The URL of the Swagger (OpenAPI 2.0) specification of the SAP IoT Service northbound API */
const SAP_Swagger_API = `https://${config.SAP_instance}.${config.SAP_landscape}/${config.SAP_instance}/iot/core/api/v1/doc/swagger/api`;

/**
 * The IoT Service data model allows for creating router devices that are authenticated once and then
 * forward the data on behalf of other devices.
 */
let router_device;

/** An instance of the SAP IoT Service northbound API instantiated with the user credentials */
let SAP_DeviceManagement;

/** The ID of the SAP IoT Services Cloud REST Gateway */
let gatewayId;

// IoT Services data types to which the corresponding Geotab typeNames are mapped.
// More types like these can be created by the programmer.
let sensorTypeId_LogRecord;
let sensorTypeId_StatusData;

// More caches like these can be created on demand
const geotabDeviceCache = {}; // key is Geotab device ID, value is the VIN of the car
const geotabDiagnosticCache = {}; // key is Geotab Diagnostic ID, value is a dictionary of properties

main();

// Only function declarations after this point.

/**
 * The main function.
 */
async function main() {
    SAP_DeviceManagement = await new Swagger(SAP_Swagger_API, {
        authorizations: {
            basicAuth: {
                username: config.SAP_username,
                password: config.SAP_password
            }
        }
    });
    //console.log('SAP northbound API', SAP_DeviceManagement);
    //console.log('Apis:', SAP_DeviceManagement.apis);
    //console.log('Definitions:', SAP_DeviceManagement.spec.definitions);

    sensorTypeId_LogRecord = await createType_LogRecord();
    sensorTypeId_StatusData = await createType_StatusData();

    gatewayId = await findCloudGatewayRest();
    router_device = await initRouterDevice();
    
    // Storage is used to preserve the state of the polling between the invocations
    // of the script. If the storage is removed from disk of the script is started
    // from a different location, the same data will be copied from Geotab to SAP
    // twice, resulting in duplicates in SAP IoT Service.
    await storage.init();
    
    // Data of different types are polled and POSTed in parallel.
    await Promise.all([
        copy_LogRecords(),
        copy_StatusData()
    ]);
}

/**
 * Read the config file in JSON format synchronosly, parse the content and return the result.
 *
 * @param {string} filename a file name relative to the script directory
 */
function readConfigFile(filename) {
    const abs_path = path.join(__dirname, filename);
    const json = fs.readFileSync(abs_path, {
        'encoding': 'utf8'
    });
    return JSON.parse(json);
}


/**
 * Create the SAP router device unless it already exists and fetch its certificate.
 */
async function initRouterDevice() {
    const routerDeviceId = await createDeviceUnlessExists(gatewayId, 'router', true);
    const absPathPem = path.join(__dirname, config.SAP_router_device_pem_filename);
    const absPathPass = path.join(__dirname, config.SAP_router_device_pass_filename);
    if (!(fs.existsSync(absPathPem) && fs.existsSync(absPathPass))) {
        const resp = await SAP_DeviceManagement.apis.Devices.getPEMCertificateUsingGET({
            tenantId: config.SAP_tenantID,
            deviceId: routerDeviceId
        });
        // console.debug(resp);
        if (resp.ok) {
            fs.writeFileSync(absPathPem, resp.body.pem);
            fs.writeFileSync(absPathPass, resp.body.secret);
            console.info('Saved the PEM and the passphrase for the router device.');
        }
    }

    const router_device_pem = fs.readFileSync(absPathPem, {
        'encoding': 'utf8'
    }); // contains both the certificate and the private key
    const router_device_passphrase = fs.readFileSync(absPathPass, {
        'encoding': 'utf8'
    }); // the private key is encrypted with it
    console.debug('The PEM and the passphrase for the router device read OK.');
    const gateway_hostname = `${config.SAP_instance}.${config.SAP_landscape}`;
    return new SAP_IoT_device_REST(gateway_hostname, router_device_pem, router_device_pem, router_device_passphrase);
}

/** 
 * Create the SAP IoT data type to which the data of Geotab typeName 'LogRecord' are mapped. 
 *
 * A datatype is specified according to the SAP IoT Service rules as a Capability and a Sensor Type
 * providing the corresponding measurement data.
 */
async function createType_LogRecord() {
    const capId = await createCapabilityUnlessExists('LogRecord', [
        { name: 'latitude',  dataType: DATATYPE.float },
        { name: 'longitude', dataType: DATATYPE.float },
        { name: 'speed',     dataType: DATATYPE.float },
        { name: 'dateTime',  dataType: DATATYPE.date }
    ]);
    return createSensorTypeUnlessExists('LogRecord', capId);
}

/** 
 * Map the Geotab typeName 'StatusData' and the 'Diagnostic' it references to SAP IoT Service data model. 
 *
 * A datatype is specified according to the SAP IoT Service rules as a Capability and a Sensor Type
 * providing the corresponding measurement data.
 */
async function createType_StatusData() {
    const capId = await createCapabilityUnlessExists('StatusData', [
        { name: 'value',          dataType: DATATYPE.float },   // StatusData.data
        { name: 'name',           dataType: DATATYPE.string },  // Diagnostic.name
        { name: 'code',           dataType: DATATYPE.integer }, // Diagnostic
        { name: 'diagnosticType', dataType: DATATYPE.string },  // Diagnostic
        { name: 'faultResetMode', dataType: DATATYPE.string },  // Diagnostic
        { name: 'dateTime',       dataType: DATATYPE.date }     // StatusData.dateTime
    ]);
    return createSensorTypeUnlessExists('StatusData', capId);
}

/**
 * Poll Geotab for records of typeName 'LogRecord' and POST them to IoT Service.
 */
async function copy_LogRecords() {
    const dateType_LogRecord = 'LogRecord';
    // Geotab expect the client to maintain the polling status.
    // The marker returned by the latest call to the API must be passed to the next one
    // as the fromVersion parameter. It is stored in the local filesystem to survive
    // restarts of the script.
	let fromVersion = await loadFromVersion(dateType_LogRecord);
    
    // The loop should run infinitely in the production environment, with the DEBUG_ITERATIONS_LIMIT
    // constant set to 0 at the top of this script. Early exit is supported for debug purposes.
    let iterationsLeft = DEBUG_ITERATIONS_LIMIT;
    do {
        let result = await readGeotabRecords(dateType_LogRecord, fromVersion);
        //console.debug(result);
        if (Array.isArray(result.data) && result.data.length > 0) {
            fromVersion = result.toVersion;
            let statusCode = await post_LogRecords(result.data);
            console.info(`Got SAP status code: ${statusCode}\n`);
            await storeFromVersion(dateType_LogRecord, fromVersion);
        } else {
            // The fetch returned no records, wait to reduce the polling load
            await sleep(POLLING_DELAY_MS);
        }
    } while (DEBUG_ITERATIONS_LIMIT <= 0 || --iterationsLeft > 0);
}

/**
 * Poll Geotab for records of typeName 'StatusData' and POST them to IoT Service. 
 *
 * See the comments in the body of copy_LogRecords(). This function is very similar,
 * but kept separate for simplicity in this sample code.
 */
async function copy_StatusData() {
    const dateType_StatusData = 'StatusData';
	let fromVersion = await loadFromVersion(dateType_StatusData);
    
    let iterationsLeft = DEBUG_ITERATIONS_LIMIT;
    do {
        let result = await readGeotabRecords(dateType_StatusData, fromVersion);
        //console.debug(result);
        if (Array.isArray(result.data) && result.data.length > 0) {
            fromVersion = result.toVersion;
            let statusCode = await post_StatusData(result.data);
            console.info(`Got SAP status code: ${statusCode}\n`);
            await storeFromVersion(dateType_StatusData, fromVersion);
        } else {
            // The fetch returned no records, wait to reduce the polling load
            await sleep(POLLING_DELAY_MS);
        }
    } while (DEBUG_ITERATIONS_LIMIT <= 0 || --iterationsLeft > 0);
}

/**
 * Load the polling state from the local persistent storage.
 */
async function loadFromVersion(dataType) {
	let from_version = await storage.getItem(dataType);
    return from_version;
}

/**
 * Store the polling state to the local persistent storage.
 */
async function storeFromVersion(dataType, version) {
	await storage.setItem(dataType, version);
    return version;
}

/**
 * Poll Geotab for records of the given type.
 */
async function readGeotabRecords(typeName, fromVersion) {
    // TODO: use the start date only if no previous records of this type were forwarded to SAP.
    const startDate = new Date((new Date()).getTime() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    // console.log("Start date:", startDate);
    return new Promise(function (resolve, reject) {
        geotab.call('GetFeed', {
            fromVersion,
            typeName,
            resultsLimit: MAX_RECORDS_PER_ITERATION,
            search: {
                fromDate: startDate
            }
        }, function (error, result) {
            if (error) {
                console.error('Got error:', error);
                reject(Error(error));
            } else {
                console.debug(
                    `Got LogRecord, toVersion: ${result.toVersion}, number or records: ${result.data.length}`);
                // console.debug('First record:', JSON.stringify(result.data[0], null, 4));
                resolve(result);
            }
        });
    });
}

/**
 * Look up the device by its ID in the Geotab API.
 *
 * @param {string} geotabDeviceId the Geotab device ID
 */
async function lookupDevice(geotabDeviceId) {
    return new Promise(function (resolve, reject) {
        geotab.call('Get', {
            typeName: 'Device',
            search: {
                id: geotabDeviceId
            }
        }, function (error, result) {
            if (error) {
                console.error('Got error:', error);
                reject(Error(error));
            } else {
                // console.debug('Got result:', result);
                if (result.length > 0) {
                    resolve(result[0]);
                } else {
                    reject(Error('Device not found!'));
                }
            }
        });
    });
}

/**
 * Look up the Geotab Diagnostic by its ID.
 *
 * @param {string} diagnosticId the Geotab Diagnostic ID
 */
async function lookupDiagnostic(diagnosticId) {
    return new Promise(function (resolve, reject) {
        geotab.call('Get', {
            typeName: 'Diagnostic',
            search: {
                id: diagnosticId
            }
        }, function (error, result) {
            if (error) {
                console.error('Got error:', error);
                reject(Error(error));
            } else {
                // console.debug('Got result:', result);
                if (result.length > 0) {
                    resolve(result[0]);
                } else {
                    reject(Error('Diagnostic not found!'));
                }
            }
        });
    });
}

/**
 * Post an array of LogRecord objects to SAP IoT Service.
 * @param {!Array<object>} records  the records to post
 */
async function post_LogRecords(records) {
    const measurements = {}; // Key: vehicle indentification number (VIN), value: an array of measurements
    for (const record of records) {
        const geotabDeviceId = record.device.id;
        // The device alternate IDs used by SAP IoT Services are generally supposed to have some
        // real-world meaning, so that they can be derived from real-world data. We use VIN numbers
        // to identify vehicles.
        let vin = geotabDeviceCache[geotabDeviceId];
        if (!vin) {
            // Cache lookup failed.
            try {
                const device = await lookupDevice(geotabDeviceId);
                // console.debug('Got device:', device);
                vin = device.vehicleIdentificationNumber;
                if (!vin) {
                    console.error(`Geotab device with ID ${geotabDeviceId} has no vehicleIdentificationNumber, skipped!`);
                   continue;
                }
                console.info(`Caching the SAP device for the vehicle with VIN='${vin}'`);
                const sapDeviceId = await createDeviceUnlessExists(gatewayId, vin);
                await createSensorUnlessExists(sapDeviceId, 'LogRecord', sensorTypeId_LogRecord);
                // Add the VIN to the cache.
                geotabDeviceCache[geotabDeviceId] = vin;
            } catch (err) {
                console.error(`Could not look up device with ID ${geotabDeviceId}!`);
                continue;
            }
        }
        // Construct the SAP IoT measurement from the Geotab record.
        (measurements[vin] = measurements[vin] || []).push({
            latitude: record.latitude,
            longitude: record.longitude,
            speed: record.speed,
            dateTime: record.dateTime
        });
    }

    const promises = [];
    for (const vin of Object.keys(measurements)) {
        // The VIN is used as the identifier of the device for SAP IoT Service. 
        promises.push(router_device.postMeasurementData(vin, 'LogRecord', 'LogRecord', measurements[vin]));
    }
    // Measurements for different vehicles (devices) are POSTed concurrently.
    // The maximum number of parallel connections is defined in SAP_IoT_device_REST.
    return Promise.all(promises);
}

/**
 * Post an array of StatusData objects to SAP IoT Service.
 * @param {!Array<object>} records  the records to post
 */
async function post_StatusData(records) {
    const measurements = {}; // Key: vehicle indentification number (VIN), value: an array of measurements
    for (const record of records) {
        const geotabDeviceId = record.device.id;
        // The device alternate IDs used by SAP IoT Services are generally supposed to have some
        // real-world meaning, so that they can be derived from real-world data. We use VIN numbers
        // to identify vehicles.
        let vin = geotabDeviceCache[geotabDeviceId];
        if (!vin) {
            try {
                // Cache lookup failed.
                const device = await lookupDevice(geotabDeviceId);
                // console.debug('Got device:', device);
                vin = device.vehicleIdentificationNumber;
                if (!vin) {
                    console.error(`Geotab device with ID ${geotabDeviceId} has no vehicleIdentificationNumber, skipped!`);
                    continue;
                }
                console.info(`Caching the SAP device for the vehicle with VIN='${vin}'`);
                const sapDeviceId = await createDeviceUnlessExists(gatewayId, vin);
                await createSensorUnlessExists(sapDeviceId, 'StatusData', sensorTypeId_StatusData);
                // Add the VIN to the cache.
                geotabDeviceCache[geotabDeviceId] = vin;
            } catch (err) {
                console.error(`Could not look up device with ID ${geotabDeviceId}!`);
                continue;
            }
        }
        
        const diagnosticId = record.diagnostic.id;
        // Here we merge the data from two Geotab records: the first of typeName StatusData
        // and the second with typeName Diagnostic, referenced by the first one.
        // The Diagnostic data for the diagnostic ID are cached in memory.
        let diagnostic = geotabDiagnosticCache[diagnosticId];
        if (!diagnostic) {
            // Cache miss
            try {
                diagnostic = await lookupDiagnostic(diagnosticId);
                // console.debug('Got diagnostic:', diagnosticRecord);
                console.info(`Caching the Geotab Diagnostic with ID='${diagnosticId}'`);
                // Add the Diagnostic to the cache
                geotabDiagnosticCache[diagnosticId] = diagnostic;
                // TODO: purge the oldest/least recently used records from the in-memory cache.
            } catch (err) {
                console.error(`Could not look up Diagnostic with ID ${diagnosticId}!`);
                continue;
            }
        }

        let value = parseFloat(record.data);
        if (isNaN(value)) {
            console.error('Numeric value expected. Skipping!');
            continue;
        }
        // Construct the SAP IoT measurement from the Geotab record and the cached Diagnostics
        (measurements[vin] = measurements[vin] || []).push({
            value,
            name: diagnostic.name,
            code: diagnostic.code,
            diagnosticType: diagnostic.diagnosticType,
            faultResetMode: diagnostic.faultResetMode,
            dateTime: record.dateTime
        });
    }

    const promises = [];
    for (const vin of Object.keys(measurements)) {
        promises.push(router_device.postMeasurementData(vin, 'StatusData', 'StatusData', measurements[vin]));
    }
    // Measurements for different vehicles (devices) are POSTed concurrently.
    // The maximum number of parallel connections is defined in SAP_IoT_device_REST.
    return Promise.all(promises);
}

/**
 * @async @function Create the Capability (essentially, a record-like data type) in SAP IoT Services if it does not exist yet.
 * @param {string} alternateId  the alternate ID of the created Capability
 * @param {!Array<object>} properties  an array of {name, dataType} objects describing fields of the record
 * @return {string}  the ID of the Capability used by SAP IoT Services
 */
async function createCapabilityUnlessExists(alternateId, properties) {
    const existingCaps = await SAP_DeviceManagement.apis.Capabilities.getCapabilitiesUsingGET(
        {
            tenantId: config.SAP_tenantID,
            filter: `alternateId eq '${alternateId}'`
        }
    );
    //console.debug('existing:', existingCaps);
    
    if (!(existingCaps.ok && Array.isArray(existingCaps.body))) {
        throw new Error('Lookup of existing capabilities failed!');
    }
    
    if (existingCaps.body.length > 0) {
        console.debug(`Capability with alternateId '${alternateId}' found, ID='${existingCaps.body[0].id}'`);
        return existingCaps.body[0].id;
    }
        
    // The lookup was OK, but the capability with this alternate ID was not found.
    console.info(`Creating a new capability '${alternateId}'`);
    const res = await SAP_DeviceManagement.apis.Capabilities.createCapabilityUsingPOST(
        {
            tenantId: config.SAP_tenantID,
            request: {
                alternateId,
                properties,
                name: alternateId 
            }
        }
    );
    // console.info(`... status code: ${res.status}, capability ID: ${res.body.id}`);
    
    if (!res.ok) {
        throw new Error('Capability creation failed!');
    }
    
    console.info(`Capability '${alternateId}' created with ID='${res.body.id}'.`);
    return res.body.id;
}

/**
 * @async @function Create the sensor type in SAP IoT Services if it does not exist yet.
 * @param {string} gatewayId  the ID of the gateway to which the device sends the data
 * @param {string} alternateId  the alternate ID of the created device
 * @param {boolean} isRouter  true if the created device can post measurements on behalf of other devices
 * @return {string}  the ID of the device used by SAP IoT Services
 */
async function createSensorTypeUnlessExists(typeName, capabilityId, isCommand=false) {
    const existingTypes = await SAP_DeviceManagement.apis.SensorTypes.getSensorTypesUsingGET(
        {
            tenantId: config.SAP_tenantID,
            filter: `name eq '${typeName}'`
        }
    );
    //console.debug('existing:', existingTypes);
    
    if (!(existingTypes.ok && Array.isArray(existingTypes.body))) {
        throw new Error('Lookup of existing sensor types failed!');
    }

    // Names are not guaranteed to be unique.
    for (const type of existingTypes.body) {
        for (const cap of type.capabilities) {
            // TODO: check for command
            if (cap.id === capabilityId) {
                console.debug(`Sensor type with name '${typeName}' found, ID='${type.id}'`);
                return type.id;
            }
        }
    }
        
    // The lookup was OK, but the sensor type with this name was not found.
    console.info(`Creating a new sensor type '${typeName}'`);
    const res = await SAP_DeviceManagement.apis.SensorTypes.createSensorTypeUsingPOST(
        {
            tenantId: config.SAP_tenantID,
            request: {
                name: typeName,
                capabilities: [{id: capabilityId, type: isCommand ? 'command' : 'measure'}]
            }
        }
    );
    // console.info(`... status code: ${res.status}, sensor type ID: ${res.body.id}`);
    
    if (!res.ok) {
        throw new Error('Sensor type creation failed!');
    }
    
    console.info(`Sensor type '${typeName}' created with ID '${res.body.id}'.`);
    return res.body.id;
}

/**
 * @async @function Find the ID of the SAP IoT Service REST gateway
 * @return {string}  the ID of the gateway used by SAP IoT Services
 */
async function findCloudGatewayRest() {
    const gateways = await SAP_DeviceManagement.apis.Gateways.getGatewaysUsingGET(                {
            tenantId: config.SAP_tenantID,
            filter: "alternateId eq 'GATEWAY_CLOUD_REST'"
        }
    );
    if (!(gateways.ok && Array.isArray(gateways.body) && gateways.body.length > 0)) {
        throw new Error('Lookup of Cloud REST gateway failed!');
    }
    console.info(`Cloud REST gateway ID is '${gateways.body[0].id}'`);
    return gateways.body[0].id;
}

/**
 * @async @function Create the device in SAP IoT Services if it does not exist yet.
 * @param {string} gatewayId  the ID of the gateway to which the device sends the data
 * @param {string} alternateId  the alternate ID of the created device
 * @param {boolean} isRouter  true if the created device can post measurements on behalf of other devices
 * @return {string}  the ID of the device used by SAP IoT Services
 */
async function createDeviceUnlessExists(gatewayId, alternateId, isRouter=false) {
    const existingDevices = await SAP_DeviceManagement.apis.Devices.getDevicesUsingGET(
        {
            tenantId: config.SAP_tenantID,
            filter: `(alternateId eq '${alternateId}') and (gatewayId eq '${gatewayId}')`
        }
    );
    //console.debug('existing:', existingDevices);
    
    if (!(existingDevices.ok && Array.isArray(existingDevices.body))) {
        throw new Error('Lookup of existing devices failed!');
    }
    
    if (existingDevices.body.length > 0) {
        console.debug(`Device with alternateId '${alternateId}' found, ID='${existingDevices.body[0].id}'`);
        //console.debug(existingDevices.body[0].authentications);
        return existingDevices.body[0].id;
    }
        
    // The lookup was OK, but the capability with this alternate ID was not found.
    console.info(`Creating a new device '${alternateId}'`);
    const request = {
        gatewayId,
        alternateId,                
        name: alternateId
    }
    if (isRouter) {
        request.authorizations = [{type: 'router'}];
    }
    const res = await SAP_DeviceManagement.apis.Devices.createDeviceUsingPOST(
        {
            request,
            tenantId: config.SAP_tenantID
        }
    );
    // console.info(`... status code: ${res.status}, device ID: ${res.body.id}`);
    
    if (!res.ok) {
        throw new Error('Device creation failed!');
    }
    
    console.info(`Device '${alternateId}' created with ID='${res.body.id}'.`);
    return res.body.id;
}

/**
 * @async @function Create the sensor in SAP IoT Services if it does not exist yet.
 * @param {string} deviceId  the ID of the device to which the sensor is attached
 * @param {string} alternateId  the alternate ID of the created sensor
 * @param {string} sensorTypeId  the ID of the type of the created sensor
 * @return {string}  the ID of the sensor used by SAP IoT Services
 */
async function createSensorUnlessExists(deviceId, alternateId, sensorTypeId) {
    const existingSensors = await SAP_DeviceManagement.apis.Sensors.getSensorsUsingGET(
        {
            tenantId: config.SAP_tenantID,
            filter: `(deviceId eq '${deviceId}') and (alternateId eq '${alternateId}')`
        }
    );
    //console.debug('existing:', existingSensors);
    
    if (!(existingSensors.ok && Array.isArray(existingSensors.body))) {
        throw new Error('Lookup of existing sensors failed!');
    }
    
    if (existingSensors.body.length > 0) {
        console.debug(`Sensor with alternateId '${alternateId}' found in device '${deviceId}', ID='${existingSensors.body[0].id}'`);
        return existingSensors.body[0].id;
    }
        
    // The lookup was OK, but the capability with this alternate ID was not found.
    console.info(`Creating a new sensor '${alternateId}'`);
    const res = await SAP_DeviceManagement.apis.Sensors.createSensorUsingPOST(
        {
            tenantId: config.SAP_tenantID,
            request: {
                deviceId,
                alternateId,
                sensorTypeId,
                name: alternateId 
            }
        }
    );
    // console.info(`... status code: ${res.status}, sensor ID: ${res.body.id}`);
    
    if (!res.ok) {
        throw new Error('Sensor creation failed!');
    }
    
    console.info(`Sensor '${alternateId}' for device '${deviceId}' created with ID='${res.body.id}'.`);
    return res.body.id;
}

/**
 * @async @function Asyc sleep for a single co-routine.
 * @param {number} ms  timeout in milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

