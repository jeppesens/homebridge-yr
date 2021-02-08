import { AccessoryPlugin, API, Logging, AccessoryConfig, Service, CharacteristicEventTypes, CharacteristicGetCallback } from 'homebridge';
import { IncomingHttpHeaders } from 'http';
import * as https from 'https';

export default ( api: API ) => {
    api.registerAccessory(
        'Yr-Temperature',
        YrTemperatureSensorAccessory,
    );
};

class YrTemperatureSensorAccessory implements AccessoryPlugin {
    private readonly service: Service;
    private validUntil: Date = new Date(0);
    private _forecast: Array<{date: Date, air_temperature: number}>;
    private set forecast(v) {
        this._forecast = v
        this.log.debug(`Setting cached temp to ${this.temperature}°C`);
    }
    private get forecast(): Array<{date: Date, air_temperature: number}> {
        return this._forecast;
    }
    private get temperature(): number {
        const selected = this._forecast.sort((a, b) => new Date().getTime() - b.date.getTime() > new Date().getTime() - a.date.getTime() ? 1 : -1)[0];
        this.log.debug(`Selected ${selected.date} for forecast with temperature ${selected.air_temperature}`);
        this.service.setCharacteristic( this.api.hap.Characteristic.CurrentTemperature, selected.air_temperature );
        return selected.air_temperature;
    }
    private coordinates: { lat: number, lon: number };

    constructor(
        private readonly log: Logging,
        private readonly config: AccessoryConfig,
        private readonly api: API,
    ) {
        this.service = new this.api.hap.Service.TemperatureSensor( this.config.name );
        this.service
            .getCharacteristic( this.api.hap.Characteristic.CurrentTemperature )
            .on( CharacteristicEventTypes.GET, this.handleCurrentTemperatureGet.bind( this ) );
    }

    private handleCurrentTemperatureGet( callback: CharacteristicGetCallback ) {
        this.log.debug('Triggered GET CurrentTemperature');
        this.getTemperature()
            .then(temp => {
                this.log.debug(`Returning temperature ${temp}`);
                callback(null, temp);
            })
            .catch(err => {
                this.log.error(err);
                callback(err);
            });
    }

    public getServices() {
        const informationService = new this.api.hap.Service.AccessoryInformation();
        informationService
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Yr.no')
            .setCharacteristic(this.api.hap.Characteristic.Model, 'Location from ipapi.co')
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, 'Jeppesens x YR');
        return[ this.service, informationService ];
    }

    private async getCoordinates() {
        if ( !this.coordinates )
            this.coordinates = await this.get<{
                latitude: number,
                longitude: number,
                [key: string]: any,
            }>('https://ipapi.co/json', {
                'User-Agent': Math.random().toString(36).substring(7),
                'Accept': '*/*',
            })
            .then( res => !res.data.error ? ({lat: res.data.latitude, lon: res.data.longitude }) : Promise.reject(res.data.reason));
        return this.coordinates;
    }

    private async get<T>(url: string, headers?: {[key: string]: string}): Promise<{data: T, headers: IncomingHttpHeaders, statusCode: number}> {
        const getHost = ( url: string ) => url.replace('https://', '').replace(/\/.*/, '');
        return new Promise((resolve, reject) =>
            https.get({
                host: getHost(url),
                path: url.replace('https://', '').replace(getHost(url), ''),
                headers,
            }, res => {
                let data = '';
                res.on( 'data', d => data += d );
                res.on( 'end', () => {
                    this.log.debug(data);
                    return res.statusCode >= 200 && res.statusCode < 400 ?
                        resolve( {
                            statusCode: res.statusCode,
                            data: JSON.parse(data),
                            headers: res.headers,
                        } ) : reject( {
                            statusCode: res.statusCode,
                            data: JSON.parse(data),
                            headers: res.headers,
                        } )
                });
            })
            .on( 'error', err => reject(err) )
        );
    }

    private async getTemperature(): Promise<number> {
        if ( !this.forecast || this.validUntil < new Date() )
            await this.getCoordinates()
                .then(({ lat, lon }) => this.get<{
                    type: string;
                    geometry: any;
                    properties: {
                        meta: any;
                        timeseries: Array<{
                            time: string,
                            data: {
                                instant: {
                                    details: {
                                        air_pressure_at_sea_level: number,
                                        air_temperature: number,
                                        cloud_area_fraction: number,
                                        relative_humidity: number,
                                        wind_from_direction: number,
                                        wind_speed: number,
                                    }
                                },
                                [additionalProps: string]: any;
                            }
                        }>;
                    };
                }
                >(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`, { 'User-Agent': 'Homebridge-YR/1.0.0' }) )
                .then(resp => {
                    this.forecast = resp.data.properties.timeseries.map(x => ({date: new Date(x.time), air_temperature: x.data.instant.details.air_temperature}));
                    this.validUntil = new Date(resp.headers.expires!);
                    this.log.debug(`Saving cache until ${this.validUntil}`);
                });
        return this.temperature;
    }
}
