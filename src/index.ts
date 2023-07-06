import { webcrypto } from 'one-webcrypto'
import { fromString, toString } from 'uint8arrays'
import { aesGenKey, aesExportKey, rsa, importAesKey, aesEncrypt } from
    '@oddjs/odd/components/crypto/implementation/browser'
import * as BrowserCrypto from '@oddjs/odd/components/crypto/implementation/browser'
import { SymmAlg } from 'keystore-idb/types.js'
import type { Crypto } from '@oddjs/odd'
import { writeKeyToDid } from '@ssc-hermes/util'

export interface Device {
    name:string,
    did:string,
    aes:string,  /* the symmetric key for this account, encrypted to the
      exchange key for this device */
    exchange:string
}

export interface Identity {
    humanName:string
    username:string,
    rootDid:string,
    devices:Record<string, Device>
}

export const ALGORITHM = SymmAlg.AES_GCM

/**
 * Create a new `identity`. This tracks a set of exchange keys by device.
 * This depends on the `crypto` interface of `odd`. That is the keystore that
 * holds the keys for your device. This creates a public record, meaning that
 * we can store this anywhere, whereas the private keys are non-exportable,
 * stored only on-device
 * @param crypto Fission crypto implementation for the current device
 * @param opts { humanName } The human-readable name of this identity
 * @returns {Identity}
 */
export async function create (
    crypto:Crypto.Implementation,
    opts:{ humanName:string }
):Promise<Identity> {
    const rootDid = await writeKeyToDid(crypto)  // this is equal to agentDid()
    const deviceName = await createDeviceName(rootDid)
    const { humanName } = opts

    // this is the private aes key for this ID
    const key = await aesGenKey(SymmAlg.AES_GCM)
    const exported = await aesExportKey(key)
    const exchangeKey = await crypto.keystore.publicExchangeKey()

    // i think only RSA is supported currently
    const encryptedKey = toString(
        await rsa.encrypt(exported, exchangeKey),
        'base64pad'
    )

    const initialDevices:Identity['devices'] = {}
    initialDevices[deviceName] = {
        aes: encryptedKey,
        name: deviceName,
        did: rootDid,
        exchange: arrToString(exchangeKey)
    }

    return {
        username: deviceName,
        humanName,
        rootDid,
        devices: initialDevices
    }
}

interface EncryptedMessage {
    payload:string,
    devices:Record<string, string>  /* devices is a record of
        { name: <encrypted key> }
        You would decrypt the encrypted key -- payload.devices[my-device-name]
        with the device's exchange key
        */
}

/**
 * Encrypt a given message to the given identity.
 * @param crypto odd crypto object
 * @param id The Identity we are encrypting to
 * @param data The message we want to encrypt
 */
export async function encryptTo (
    id:Identity,
    data
):Promise<EncryptedMessage> {
    // need to encrypt a key to each exchange key
    // then encrypt the data with the key
    const key = await aesGenKey(SymmAlg.AES_GCM)

    // so this return an encrypted version of the message passed in
    // the encrypted message includes a symmetric key that has been encrypted
    //   to each device of the given identity
    // to decrypt this message, use your exchange key to decrypt the symm key,
    //   then use the symm key to decrypt the payload

    const encryptedKeys = Object.keys(id.devices).reduce(async (acc, deviceName) => {
        const encrypted = toString(await rsa.encrypt(await aesExportKey(key),
            fromString(id.devices[deviceName].exchange)), 'base64pad')

        acc[deviceName] = encrypted
        return acc
    }, {})

    const payload = toString(await aesEncrypt(data, key, SymmAlg.AES_GCM))

    return { payload, devices: encryptedKeys }
}

/**
 * Encrypt a given AES key to the given exchange key
 * @param key The symmetric key
 * @param exchangeKey The exchange key to encrypt *to*
 * @returns the encrypted key, encoded as 'base64pad'
 */
async function encryptKey (key:CryptoKey, exchangeKey:Uint8Array|CryptoKey) {
    const encryptedKey = toString(
        await rsa.encrypt(await aesExportKey(key), exchangeKey),
        'base64pad'
    )

    return encryptedKey
}

/**
 * Decrypt the given encrypted key
 * @param {string} encryptedKey The encrypted key, returned by `create`
 * -- identity.devices[name].aes
 * @param {Crypto.Implementation} crypto An instance of Fission's crypto
 * @returns {Promise<CryptoKey>} The symmetric key
 */
export async function decryptKey (crypto:Crypto.Implementation, encryptedKey:string)
:Promise<CryptoKey> {
    const decrypted = await crypto.keystore.decrypt(
        fromString(encryptedKey, 'base64pad'))

    const key = await importAesKey(decrypted, SymmAlg.AES_GCM)
    return key
}

function hasProp<K extends PropertyKey> (data: unknown, prop: K):
data is Record<K, unknown> {
    return typeof data === 'object' && data != null && prop in data
}

function isCryptoKey (val:unknown):val is CryptoKey {
    return (hasProp(val, 'algorithm') &&
        hasProp(val, 'extractable') && hasProp(val, 'type'))
}

// the existing devices are the only places that can decrypt the key
// must call `add` from an existing device

/**
 * Add a device to this identity. This is performed from a device that is currently
 * registered. You need to get the exchange key of the new device somehow.
 * @param {Identity} id The `Identity` instance to add to
 * @param {Crypto.Implementation} crypto An instance of Fission's crypto
 * @param {string} newDid The DID of the new device
 * @param {Uint8Array} exchangeKey The exchange key of the new device
 * @returns {Identity} A new identity object, with the new device
 */
export async function add (
    id:Identity,
    crypto:Crypto.Implementation,
    newDid:string,
    exchangeKey:Uint8Array|CryptoKey,
) {
    // need to decrypt the existing AES key, then re-encrypt it to the
    // new did

    // this is all happening on a device that is already authed

    // var exportPromise = crypto.subtle.exportKey('raw', aesKey);

    const existingDid = await writeKeyToDid(crypto)
    const existingDeviceName = await createDeviceName(existingDid)
    const secretKey = await decryptKey(crypto,
        id.devices[existingDeviceName].aes)

    // ??? how to get the exchange key of the new device ???
    const encrypted = await encryptKey(secretKey, exchangeKey)
    const newDeviceData:Identity['devices'] = {}
    const name = await createDeviceName(newDid)
    const _exchangeKey = isCryptoKey(exchangeKey) ?
        await webcrypto.subtle.exportKey('raw', secretKey) :
        exchangeKey

    newDeviceData[name] = {
        name,
        aes: encrypted,
        did: newDid,
        exchange: arrToString(new Uint8Array(_exchangeKey))
    }

    const newId:Identity = {
        ...id,
        devices: Object.assign(id.devices, newDeviceData)
    }

    return newId
}

export async function createDeviceName (did:string) {
    const normalizedDid = did.normalize('NFD')
    const hashedUsername = await BrowserCrypto.sha256(
        new TextEncoder().encode(normalizedDid)
    )
    return toString(hashedUsername, 'base32').slice(0, 32)
}

function arrToString (arr:Uint8Array) {
    return toString(arr, 'base64pad')
}
