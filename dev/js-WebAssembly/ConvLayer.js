"use strict"

class ConvLayer {

    constructor (size, {filterSize, zeroPadding, stride, activation}={}) {

        this.size = size
        this.stride = stride
        this.filterSize = filterSize
        this.layerIndex = 0
        this.zeroPadding = zeroPadding

        this.activation = false
        this.activationName = activation

        if (activation != undefined) {
            if (typeof activation == "boolean" && !activation) {
                activation = "noactivation"
            }
            if (typeof activation != "string") {
                throw new Error("Custom activation functions are not available in the WebAssembly version")
            }
            this.activationName = NetUtil.format(activation)
        }
    }

    assignNext (layer) {
        this.nextLayer = layer
    }

    assignPrev (layer, layerIndex) {

        this.netInstance = this.net.netInstance
        this.prevLayer = layer
        this.layerIndex = layerIndex

        const stride = this.stride || this.net.conv.stride || 1
        const filterSize = this.filterSize || this.net.conv.filterSize || 3
        let zeroPadding = this.zeroPadding

        NetUtil.defineProperty(this, "channels", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})
        NetUtil.defineProperty(this, "filterSize", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})
        NetUtil.defineProperty(this, "stride", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})
        NetUtil.defineProperty(this, "zeroPadding", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})

        this.size = this.size || 4
        let channels

        switch (true) {
            case layer instanceof FCLayer:
                channels = this.net.channels || 1
                break

            case layer instanceof ConvLayer:
                channels = layer.size
                break

            case layer instanceof PoolLayer:
                channels = layer.activations.length
                break
        }

        if (zeroPadding == undefined) {
            zeroPadding = this.net.conv.zeroPadding==undefined ? Math.floor(filterSize/2) : this.net.conv.zeroPadding
        }

        this.channels = channels
        this.filterSize = filterSize
        this.stride = stride
        this.zeroPadding = zeroPadding

        // Caching calculations
        const prevLayerOutWidth = layer instanceof FCLayer ? Math.max(Math.floor(Math.sqrt(layer.size/channels)), 1)
                                                           : layer.outMapSize

        NetUtil.defineProperty(this, "inMapValuesCount", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})
        NetUtil.defineProperty(this, "inZPMapValuesCount", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})
        NetUtil.defineProperty(this, "outMapSize", ["number", "number"], [this.netInstance, layerIndex], {pre: "conv_"})

        const outSize = (prevLayerOutWidth - filterSize + 2*zeroPadding) / stride + 1
        this.inMapValuesCount = Math.pow(prevLayerOutWidth, 2)
        this.inZPMapValuesCount = Math.pow(prevLayerOutWidth + zeroPadding*2, 2)
        this.outMapSize = outSize

        if (outSize%1!=0) {
            throw new Error(`Misconfigured hyperparameters. Activation volume dimensions would be ${outSize} in conv layer at index ${layerIndex}`)
        }

        if (this.activationName !== false && this.net.activationName !== false) {
            NetUtil.defineProperty(this, "activation", ["number", "number"], [this.netInstance, layerIndex], {
                pre: "conv_",
                getCallback: _ => `WASM ${this.activationName||this.net.activationName}`
            })
            this.activation = NetUtil.activationsIndeces[this.activationName||this.net.activationName]
        }

        this.filters = [...new Array(this.size)].map(f => new Filter())
    }

    init () {
        this.filters.forEach((filter, fi) => {

            const paramTypes = ["number", "number", "number"]
            const params = [this.netInstance, this.layerIndex, fi]

            NetUtil.defineMapProperty(filter, "activationMap", paramTypes, params, this.outMapSize, this.outMapSize, {pre: "filter_"})
            NetUtil.defineMapProperty(filter, "errorMap", paramTypes, params, this.outMapSize, this.outMapSize, {pre: "filter_"})
            NetUtil.defineMapProperty(filter, "sumMap", paramTypes, params, this.outMapSize, this.outMapSize, {pre: "filter_"})
            NetUtil.defineMapProperty(filter, "dropoutMap", paramTypes, params, this.outMapSize, this.outMapSize, {
                pre: "filter_",
                getCallback: m => m.map(row => row.map(v => v==1))
            })

            filter.init(this.netInstance, this.layerIndex, fi, {
                updateFn: this.net.updateFn,
                filterSize: this.filterSize,
                channels: this.channels
            })
        })
    }

    toJSON () {
        return {
            weights: this.filters.map(filter => {
                return {
                    bias: filter.bias,
                    weights: filter.weights
                }
            })
        }
    }

    fromJSON (data, layerIndex) {
        this.filters.forEach((filter, fi) => {

            if (data.weights[fi].weights.length != filter.weights.length) {
                throw new Error(`Mismatched weights depth. Given: ${data.weights[fi].weights.length} Existing: ${filter.weights.length}. At: layers[${layerIndex}], filters[${fi}]`)
            }

            if (data.weights[fi].weights[0].length != filter.weights[0].length) {
                throw new Error(`Mismatched weights size. Given: ${data.weights[fi].weights[0].length} Existing: ${filter.weights[0].length}. At: layers[${layerIndex}], filters[${fi}]`)
            }

            filter.bias = data.weights[fi].bias
            filter.weights = data.weights[fi].weights
        })
    }

    // Used for importing data
    getDataSize () {

        let size = 0

        for (let f=0; f<this.filters.length; f++) {

            const filter = this.filters[f]

            for (let c=0; c<filter.weights.length; c++) {
                for (let r=0; r<filter.weights[c].length; r++) {
                    size += filter.weights[c][r].length
                }
            }

            size += 1
        }

        return size
    }

    toIMG () {
        const data = []

        for (let f=0; f<this.filters.length; f++) {
            const filter = this.filters[f]

            data.push(filter.bias)

            for (let c=0; c<filter.weights.length; c++) {
                for (let r=0; r<filter.weights[c].length; r++) {
                    for (let v=0; v<filter.weights[c][r].length; v++) {
                        data.push(filter.weights[c][r][v])
                    }
                }
            }
        }

        return data
    }

    fromIMG (data) {
        let valI = 0

        for (let f=0; f<this.filters.length; f++) {

            const filter = this.filters[f]
            filter.bias = data[valI]
            valI++

            let newFilterWeights = filter.weights.slice(0)

            for (let c=0; c<filter.weights.length; c++) {
                for (let r=0; r<filter.weights[c].length; r++) {
                    for (let v=0; v<filter.weights[c][r].length; v++) {
                        // filter.weights[c][r][v] = data[valI]
                        newFilterWeights[c][r][v] = data[valI]
                        valI++
                    }
                }
            }

            filter.weights = newFilterWeights
        }
    }
}

// https://github.com/DanRuta/jsNet/issues/33
/* istanbul ignore next */
if (typeof window!="undefined") {
    window.exports = window.exports || {}
    window.global = window.global || {}
    window.global.jsNetWASMPath = "./NetWASM.wasm"
    window.ConvLayer = ConvLayer
}
exports.ConvLayer = ConvLayer
