import type * as hb from "homebridge";
import type * as hap from "hap-nodejs";

import * as miio from "miio-api";
import { DeviceOptions, PlatformAccessory } from "../platform";
import { Humidifier } from "./factory";
import { AnyCharacteristicConfig } from "./features";
import { Protocol } from "./protocols";
import { ValueOf } from "./utils";
import { Logger } from "./logger";
import { EveHistoryService, HistoryServiceEntry } from "../lib/eve-history";

/**
 * Base class for all humidifiers, all humidifiers must inherit from this class.
 *
 * @typeParam PropsType key-value type containing all supported device
 *   properties types. For better defaults it is recommended to use
 *   device properties names as keys is possible.
 */
export class BaseHumidifier<PropsType extends BasePropsType>
  implements Humidifier {
  private props: GetEntry<PropsType>[];
  private cache: PropsType;
  private historyServices: Record<string, EveHistoryService> = {};

  /**
   * @param protocol device protocol.
   * @param features device characteristics configurations.
   * @param log logger.
   */
  constructor(
    private readonly api: hb.API,
    private readonly protocol: Protocol<PropsType>,
    private readonly features: Array<AnyCharacteristicConfig<PropsType>>,
    private readonly log: Logger,
    private readonly options: DeviceOptions,
  ) {
    this.props = [];
    this.cache = {} as PropsType;
  }

  /**
   * Adds services and characteristics to the accessory.
   * This method should be overwritten in child classes to add
   * all necessary services and characteristics.
   *
   * @param accessory homebridge accessory
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.features.forEach((feature) => {
      this.register(accessory, feature);
    });

    const enabledServices = new Set(
      this.features.map(
        (feature) =>
          feature.service.UUID + (feature.name ? feature.name.subtype : ""),
      ),
    );

    // Cleanup disabled services and characteristics.
    accessory.services.forEach((service) => {
      if (!enabledServices.has(service.getServiceId())) {
        this.log.debug("Removing service", service.getServiceId());
        accessory.removeService(service);
      }

      const enabledCharacteristics = new Set(
        this.features
          .filter(
            (it) =>
              it.service.UUID + (it.name ? it.name.subtype : "") ===
              service.getServiceId(),
          )
          .map((it) => it.characteristic.UUID),
      );

      service.characteristics.forEach((char) => {
        if (!enabledCharacteristics.has(char.UUID)) {
          this.log.debug("Removing characteristic", char.UUID);
          service.removeCharacteristic(char);
        }
      });
    });

    //create history services for accessory
    const historyTypes = new Set<string>();
    this.features.forEach((feature) => {
      if ("historyType" in feature) {
        historyTypes.add(feature["historyType"]);
      }
    });

    this.log.debug("Identified requested history types: ", historyTypes);
    historyTypes.forEach((type) => {
      this.historyServices[type] = new EveHistoryService(
        type,
        accessory,
        this.api,
        (this.log as unknown) as hb.Logging,
      );
    });
  }

  /**
   * Function to use in polling.
   *
   * Requests all registered device properties and stores them in cache
   * to return later in `CharacteristicGetCallback`.  Also asynchronously
   * updates corresponding HomeKit characteristics.
   */
  public async update(): Promise<void> {
    try {
      this.cache = await this.protocol.getProps(
        this.props.map((prop) => prop.key),
      );
      this.props.forEach((prop) => {
        const propValue = this.cache[prop.key];

        prop.values.forEach((value) => {
          const charValue = value.map(propValue);
          this.log.debug(
            `Updating property "${prop.key}": ${propValue} -> ${charValue}`,
          );
          value.characteristic.updateValue(charValue);
        });
      });
    } catch (err) {
      this.log.error(
        `Fail to get device properties. ${err.constructor.name}: ${err.message}`,
      );
      if (err instanceof miio.ProtocolError) {
        this.log.warn(
          "Got ProtocolError which indicates use of an invalid token. Please, check that provided token is correct!",
        );
      }
    }
  }

  /**
   * Registers characteristic for the given accessory and service.
   */
  register<PropsKey extends keyof PropsType>(
    accessory: PlatformAccessory,
    config: CharacteristicConfig<PropsType, PropsKey, PropsType[PropsKey]>,
  ): void {
    let service;

    if (config.name) {
      service =
        accessory.getService(config.name.displayName) ||
        accessory.addService(
          config.service,
          config.name.displayName,
          config.name.subtype,
        );
    } else {
      service =
        accessory.getService(config.service) ||
        accessory.addService(config.service);
    }

    const characteristic = service.getCharacteristic(config.characteristic);

    if (config.props) {
      characteristic.setProps(config.props);
    }

    if ("value" in config) {
      if (typeof config.value === "function") {
        // Callback.
        characteristic.on("get", config.value);
      } else {
        // Static value.
        characteristic.setValue(config.value);
      }
    } else {
      // Dynamic characteristic.
      let getMap = config.get?.map
        ? (config.get.map as GetMapFunc<PropsType>)
        : (it: PrimitiveType) => it; // by default return the same value.

      // if history props are defined:
      // call original getMap,
      // and add value to history service entries
      if ("historyKey" in config && "historyType" in config) {
        const oldMap = getMap;
        getMap = (it: ValueOf<PropsType>) => {
          const result = oldMap(it);

          if (!result) {
            return result;
          }

          const historyType = config["historyType"];
          const historyService = this.historyServices[historyType];
          if (historyService) {
            let entry = historyService.getLastEntry();
            if (!entry) {
              entry = {
                time: Math.round(new Date().valueOf() / 1000),
              };
            } else {
              entry.time = Math.round(new Date().valueOf() / 1000);
            }
            const entryKey: string = config["historyKey"];
            entry[entryKey] = parseInt(" " + result.valueOf());
            this.log.debug(
              "Adding history entry, type:",
              historyType,
              " entry: ",
              entry,
            );
            historyService.addEntry(entry);
          } else {
            this.log.debug("Could not log history entry, type:", historyType);
          }

          return result;
        };
      }

      const entry = this.props.find((prop) => prop.key === config.key);

      if (entry) {
        // If prop entry is already saved, just add new characteristic to it.
        entry.values.push({
          characteristic: characteristic,
          map: getMap,
        });
      } else {
        // Save prop entry.
        this.props.push({
          key: config.key,
          values: [
            {
              characteristic: characteristic,
              map: getMap,
            },
          ],
        });
      }

      characteristic.on("get", (callback: hb.CharacteristicGetCallback) => {
        this.getProp(config.key, getMap, callback);
      });

      if (config.set) {
        const setEntry: SetEntry<PropsType> = {
          key: config.key,
          call: config.set.call,
          characteristic: characteristic,
          map: config.set.map
            ? config.set.map
            : (it: hb.CharacteristicValue) => it as ValueOf<PropsType>, // by default use the same value.
          beforeSet: config.set.beforeSet,
          afterSet: config.set.afterSet,
        };

        characteristic.on(
          "set",
          async (
            value: hb.CharacteristicValue,
            callback: hb.CharacteristicSetCallback,
          ) => {
            return await this.setProp(setEntry, value, callback);
          },
        );
      }
    }
  }

  /**
   * Function which is used as homebridge `CharacteristicGetCallback` for
   * all registered characteristics.
   *
   * Returns last cached property value. This method don't make
   * device call because some devices are slow to respond and if we
   * will request every prop from device here HomeKit will become unresponsive.
   *
   * @param key property identifier.
   * @param map function that converts property value to characteristic.
   * @param callback characteristic get callback.
   */
  private getProp(
    key: keyof PropsType,
    map: (it: ValueOf<PropsType>) => hb.CharacteristicValue,
    callback: hb.CharacteristicGetCallback,
  ): void {
    this.log.debug(`Getting property "${key}"`);
    const value = this.cache[key] ? this.cache[key] : null;
    callback(null, map(value));
  }

  /**
   * Function which used as homebridge `CharacteristicSetCallback` for
   * all registered characteristics.
   *
   * This function in contrast to `getProp` makes device call.
   *
   * @param entry `SetEntry` object for prop.
   * @param value value to set for property.
   * @param callback characteristic set callback.
   */
  private async setProp(
    entry: SetEntry<PropsType>,
    value: hb.CharacteristicValue,
    callback: hb.CharacteristicSetCallback,
  ) {
    this.log.debug(`Setting property "${entry.key}" to ${value}`);

    try {
      let skipSet;

      if (entry.beforeSet) {
        skipSet = await entry.beforeSet({
          value,
          characteristic: entry.characteristic,
          protocol: this.protocol,
        });
      }

      const mappedValue = entry.map(value);

      if (skipSet !== true) {
        await this.protocol.setProp(entry.key, entry.call, mappedValue);
      }

      if (entry.afterSet) {
        await entry.afterSet({
          value,
          mappedValue,
          characteristic: entry.characteristic,
          protocol: this.protocol,
        });
      }

      callback();
    } catch (err) {
      this.log.error(
        `Fail to set device property "${entry.key}". ${err.constructor.name}: ${err.message}`,
      );
      callback(err);
    }
  }
}

/**
 * Device property value type.
 */
export type PrimitiveType = string | number | boolean;

/**
 * Base props type.
 * `PropsType` of child class must this type.
 */
export type BasePropsType = { [key: string]: PrimitiveType };

/**
 * Function that maps device property value to corresponding characteristic value.
 */
export type GetMapFunc<PropsType> = (
  it: ValueOf<PropsType>,
) => hb.CharacteristicValue;

/**
 * Function that maps characteristic value to corresponding device property value.
 */
export type SetMapFunc<PropsType> = (
  it: hb.CharacteristicValue,
) => ValueOf<PropsType>;

/**
 * Function that is called before settings the device property.
 */
export type BeforeSetFunc<PropsType> = (
  args: BeforeSetFuncArgs<PropsType>,
) => boolean | Promise<boolean> | void | Promise<void>;

export type BeforeSetFuncArgs<PropsType> = {
  value: hb.CharacteristicValue;
  characteristic: hb.Characteristic;
  protocol: Protocol<PropsType>;
};

/**
 * Function that is called after settings the device property.
 */
export type AfterSetFunc<PropsType> = (
  args: AfterSetFuncArgs<PropsType>,
) => void | Promise<void>;

export type AfterSetFuncArgs<PropsType> = {
  value: hb.CharacteristicValue;
  mappedValue: PrimitiveType;
  characteristic: hb.Characteristic;
  protocol: Protocol<PropsType>;
};

/**
 * GetEntry contains all required information
 * to get property from device, convert it to HomeKit characteristic value
 * and update corresponding accessory characteristic.
 */
export type GetEntry<PropsType> = {
  // Property identifier.
  key: keyof PropsType;

  values: Array<{
    // Accessories characteristics that must be updated with device property value.
    characteristic: hb.Characteristic;

    // Function that converts device property to corresponding characteristic value.
    map: (it: ValueOf<PropsType>) => hb.CharacteristicValue;
  }>;
};

/**
 * GetEntry contains all information required to
 * convert HomeKit characteristic value to device property
 * and set it on the device.
 */
export type SetEntry<PropsType> = {
  // Property identifier.
  key: keyof PropsType;

  // Accessory characteristic.
  characteristic: hb.Characteristic;

  // Name of device call that updates the property.
  call: string;

  // Function that converts characteristic value to corresponding device property value.
  map: (it: hb.CharacteristicValue) => ValueOf<PropsType>;

  // Function that is called before settings the device property.
  // Can be used to add some extra logic.
  beforeSet?: BeforeSetFunc<PropsType>;

  // Function that is called after settings the device property.
  // Can be used to add some extra logic.
  afterSet?: AfterSetFunc<PropsType>;
};

/**
 * Useful type aliases.
 */
export type Characteristic = hb.WithUUID<new () => hap.Characteristic>;
export type Service = hb.WithUUID<typeof hap.Service>;

/**
 * CharacteristicConfig is used to register characteristic for accessory.
 */
export type CharacteristicConfig<PropsType, PropKey, PropValue> =
  | CharacteristicConfigStatic
  | CharacteristicConfigDynamic<PropsType, PropKey, PropValue>;

export type CharacteristicConfigStatic = {
  // HomeKit service.
  service: Service;

  // HomeKit service name (required if we have multiple services of the same type).
  name?: {
    displayName: string;
    subtype: string;
  };

  // HomeKit characteristic.
  characteristic: Characteristic;
  // HomeKit characteristic properties if required.
  props?: Partial<hb.CharacteristicProps>;
  // HomeKit characteristic value.
  value:
    | hb.CharacteristicValue
    | ((callback: hb.CharacteristicGetCallback) => void);
};

export type CharacteristicConfigDynamic<PropsType, PropKey, PropValue> = {
  // HomeKit service.
  service: Service;

  // HomeKit service name (required if we have multiple services of the same type).
  name?: {
    displayName: string;
    subtype: string;
  };

  // HomeKit characteristic.
  characteristic: Characteristic;

  // HomeKit characteristic properties if required.
  props?: Partial<hb.CharacteristicProps>;

  // Device props key. Used as property identifier.
  key: PropKey;

  // Characteristic get config.
  get?: {
    // Function that converts device property value to the corresponding
    // HomeKit characteristic value.
    // If not provided the same value will be used.
    map?: (it: PropValue) => hb.CharacteristicValue;
  };
  // Characteristic set config.
  set?: {
    // Set characteristic call name.
    call: string;

    // Function that converts HomeKit characteristic value
    // to the corresponding device property value.
    // If not provided the same value will be used.
    map?: (it: hb.CharacteristicValue) => PropValue;

    // Function that is called before settings the device property.
    // Can be used to add some extra logic.
    // You can return "true" to skip property set call.
    beforeSet?: BeforeSetFunc<PropsType>;

    // Function that is called before settings the device property.
    // Can be used to add some extra logic.
    afterSet?: AfterSetFunc<PropsType>;
  };
};
