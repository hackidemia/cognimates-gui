import PropTypes from 'prop-types';
import React from 'react';

import BridgeHost, {resolveAllowedParentOrigins} from './cognimates-bridge/bridge-host';
import createVmAdapter from './cognimates-bridge/vm-adapter';
import log from './log';

/* global COGNIMATES_BRIDGE_PARENT_ORIGINS, COGNIMATES_EDITOR_VERSION */
const configuredOrigins = typeof COGNIMATES_BRIDGE_PARENT_ORIGINS === 'string' ?
    COGNIMATES_BRIDGE_PARENT_ORIGINS : '';
const editorVersion = typeof COGNIMATES_EDITOR_VERSION === 'string' ? COGNIMATES_EDITOR_VERSION : 'dev';

/**
 * Higher Order Component that exposes the running editor to the Cognimates
 * assistant through the validated postMessage bridge. It is inert unless the
 * editor is embedded by an allowed parent origin, so the editor stays fully
 * usable on its own or when the assistant is unavailable.
 * @param {React.Component} WrappedComponent component to wrap
 * @returns {React.Component} component with the bridge attached
 */
const CognimatesBridgeHOC = function (WrappedComponent) {
    class CognimatesBridge extends React.Component {
        componentDidMount () {
            const store = this.context.store;
            if (!store || typeof window === 'undefined') return;
            const vm = store.getState().scratchGui.vm;
            try {
                this.adapter = createVmAdapter({vm,
                    store,
                    onBusy: busy => {
                    // A project replacement is a short transaction. Prevent
                    // new mouse/keyboard edits until it commits or recovers.
                        document.body.inert = busy;
                    }});
                this.host = new BridgeHost({
                    win: window,
                    allowedOrigins: resolveAllowedParentOrigins(configuredOrigins, window.location.origin),
                    adapter: this.adapter,
                    editorInfo: {name: 'cognimates-gui', version: editorVersion},
                    onWarn: (message, err) => log.warn(message, err || '')
                });
                if (!this.host.start()) {
                    this.adapter.dispose();
                    this.adapter = null;
                    this.host = null;
                }
            } catch (e) {
                // The bridge is optional; never let it break the editor.
                log.warn('Cognimates bridge disabled', e);
                this.host = null;
            }
        }
        componentWillUnmount () {
            document.body.inert = false;
            if (this.host) this.host.stop();
            if (this.adapter) this.adapter.dispose();
            this.host = null;
            this.adapter = null;
        }
        render () {
            return <WrappedComponent {...this.props} />;
        }
    }
    CognimatesBridge.contextTypes = {
        store: PropTypes.object // eslint-disable-line react/forbid-prop-types
    };
    return CognimatesBridge;
};

export default CognimatesBridgeHOC;
