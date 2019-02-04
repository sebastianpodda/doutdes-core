'use strict';

/* External services */
const HttpStatus = require('http-status-codes');
const Request = require('request-promise');

/* DB Models */
const Model = require('../models/index');
const Users = Model.Users;
const FbToken = Model.FbToken;
const GaToken = Model.GaToken;

/* Api Handlers */
const FbAPI = require('../api_handler/facebook-api');
const GaAPI = require('../api_handler/googleAnalytics-api');

const D_TYPE = require('../engine/dashboard-manager').D_TYPE;
const DS_TYPE = require('../engine/dashboard-manager').DS_TYPE;

const readAllKeysById = (req, res) => {

    Users.findOne({
            where: {id: req.user.id},
            include: [
                {model: GaToken},
                {model: FbToken}]
        }
    )
        .then(result => {
            let fb = result.dataValues.FbTokens[0];
            let ga = result.dataValues.GaTokens[0];

            if (fb == null && ga == null)
                return res.status(HttpStatus.NO_CONTENT).send({});

            let fb_token = (fb == null) ? null : fb.dataValues.api_key;      // FB Token
            let ga_token = (ga == null) ? null : ga.dataValues.private_key;  // GA Token

            return res.status(HttpStatus.OK).send({
                user_id: req.user.id,
                fb_token: fb_token,
                ga_token: ga_token
            });
        })
        .catch(err => {
            console.error(err);
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
                error: 'Cannot retrieve user tokens.'
            })
        });
};

const checkFbTokenValidity = async (req, res) => {
    let key, data;

    try {
        key = await FbToken.findOne({where: {user_id: req.user.id}});

        if(!key) {
            return res.status(HttpStatus.BAD_REQUEST).send({
                name: 'Token not found',
                message: 'Before to check the validity of the Facebook token, you should provide one token instead.'
            })
        }

        data = await FbAPI.getTokenInfo(key.api_key);

        if (!data['is_valid']) throw new Error(HttpStatus.UNAUTHORIZED.toString());

        return res.status(HttpStatus.OK).send({
            valid: data['is_valid'],
            type: data['type'],
            application: data['application']
        });

    } catch (err) {
        console.error(err);

        if((err + '').includes(HttpStatus.UNAUTHORIZED.toString())) {
            return res.status(HttpStatus.UNAUTHORIZED).send({
                name: 'Facebook Token Error',
                message: 'The token is no longer valid.'
            });
        }

        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            name: 'Internal Server Error',
            message: 'There is a problem either with Facebook servers or with our database'
        })
    }
};

const checkExistence = async (req, res) => {
    let joinModel;

    switch(req.params.type){
        case '0': joinModel = FbToken;
            break;
        case '1': joinModel = GaToken;
            break;
        default:
            return res.status(HttpStatus.BAD_REQUEST).send({
                error: true,
                message: 'Cannot find a service of type ' + req.params.type + '.'
            })
    }

    try {
        const key = await Users.findOne({where: {id: req.user.id}, include: [{model: joinModel}]});

        if((key['dataValues']['FbTokens'] && key['dataValues']['FbTokens'].length > 0) ||
            (key['dataValues']['GaTokens'] && key['dataValues']['GaTokens'].length > 0)) {
            return res.status(HttpStatus.OK).send({
                exists: true,
                service: parseInt(req.params.type)
            })
        } else {
            return res.status(HttpStatus.OK).send({
                exists: false,
                service: parseInt(req.params.type)
            });
        }

    } catch (e) {
        console.error(e);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            error: true,
            message: 'An error occurred while checking the existence of a token service.'
        })
    }
};

const permissionGranted = async (req, res) => {
    let scopes = [];
    let hasPermission, key;

    if(req.params.type == '0' || req.params.type == '2') { // Facebook or Instagram
        key = await FbToken.findOne({where: {user_id: req.user.id}});
    } else {
        key = await GaToken.findOne({where: {user_id: req.user.id}});
    }

    if(!key){ // If a key is not set, return error
        return res.status(HttpStatus.OK).send({
            name: DS_TYPE[parseInt(req.params.type)],
            type: parseInt(req.params.type),
            granted: false,
            scopes: null
        });
        /*        return res.status(HttpStatus.BAD_REQUEST).send({
            name: 'Permissions granted error - Key not available',
            message: 'You can\'t check the permissions granted without providing a token'
        });*/
    }

    try {
        switch (parseInt(req.params.type)) {
            case D_TYPE.FB: // Facebook
                scopes = (await FbAPI.getTokenInfo(key['api_key']))['data']['scopes'];
                hasPermission = checkFBContains(scopes);
                scopes = scopes.filter(el => !el.includes('instagram'));
                break;
            case D_TYPE.GA: // Google Analytics
                scopes = (await GaAPI.getTokenInfo(key['private_key']))['scope'].split(' ');
                hasPermission = checkGAContains(scopes);
                scopes = scopes.filter(el => !el.includes('yt-analytics'));
                break;
            case D_TYPE.IG: // Instagram
                scopes = (await FbAPI.getTokenInfo(key['api_key']))['data']['scopes'];
                hasPermission = checkIGContains(scopes);
                scopes = scopes.filter(el => el.includes('instagram'));
                break;
            case D_TYPE.YT: // YouTube
                scopes = (await GaAPI.getTokenInfo(key['private_key']))['scope'].split(' ');
                hasPermission = checkYTContains(scopes);
                scopes = scopes.filter(el => el.includes('yt-analytics'));
                break;
            default:
                return res.status(HttpStatus.BAD_REQUEST).send({
                    error: true,
                    message: 'The service with id ' + req.params.type + ' does not exist.'
                });
        }

        return res.status(HttpStatus.OK).send({
            name: DS_TYPE[parseInt(req.params.type)],
            type: parseInt(req.params.type),
            granted: hasPermission === 1,
            scopes: hasPermission === 1 ? scopes : null
        })

    } catch (err) {
        console.error(err);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            error: true,
            message: 'There is a problem with our servers.'
        })
    }
};

const insertKey = (req, res) => {
    const service_id = parseInt(req.body.service_id);

    switch (service_id) {
        case 0: // fb
            return insertFbKey(req, res);
        case 1: // google
            return insertGaData(req, res);
        default:
            console.log('ERROR TOKEN-MANAGER. Unrecognized service type: ' + service_id);
            return res.status(HttpStatus.BAD_REQUEST).send({
                created: false,
                error: 'Unrecognized service type.'
            });
    }
};

const update = (req, res) => {
    const service_id = parseInt(req.body.service_id);
    switch (service_id) {
        case 0: //fb
            return updateFbKey(req, res);
        case 1: //google
            return updateGaData(req, res);
        default:
            return res.status(HttpStatus.BAD_REQUEST).send({
                created: false,
                error: 'Unrecognized service type.'
            });
    }

};

const deleteKey = (req, res) => {
    const service_id = parseInt(req.body.service_id);

    switch (service_id) {
        case 0: //fb
            return deleteFbKey(req, res);
        case 1: //google
            return deleteGaData(req, res);
        default:
            return res.status(HttpStatus.BAD_REQUEST).send({
                created: false,
                error: 'Unrecognized service type.'
            });
    }
};

const insertFbKey = (req, res) => {
    FbToken.findOne({
        where: {
            user_id: req.user.id,
        }
    }).then(async key => {
        if (key !== null) {
            console.log('ERROR TOKEN-MANAGER. Key already exists.');
            return res.status(HttpStatus.BAD_REQUEST).send({
                error: 'Facebook token already exists'
            })
        }
        else {
            // Get the right token by doing the call to /me/accounts
            const token = await getPageToken(req.body.api_key);

            FbToken.create({
                user_id: req.user.id,
                api_key: token
            })
                .then(new_key => {
                    return res.status(HttpStatus.CREATED).send({
                        created: true,
                        api_key: token
                    });
                })
                .catch(err => {
                    console.log('ERROR TOKEN-MANAGER. Cannot insert the row in db. Details below:');
                    console.error(err);
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
                        created: false,
                        api_key: token,
                        error: 'Cannot insert the key'
                    });
                })
        }
    })
};

const insertGaData = (req, res) => {
    GaToken.findOne({
        where: {
            user_id: req.user.id,
        }
    }).then(key => {
        if (key !== null) {
            return res.status(HttpStatus.BAD_REQUEST).send({
                error: 'Google Analytics access token already exists!'
            });
        }
        else {
            let user_id = req.user.id;
            let private_key = req.body.private_key;

            GaToken.create({
                user_id: user_id,
                private_key: private_key
            })
                .then(new_key => {
                    return res.status(HttpStatus.CREATED).send({
                        created: true,
                        private_key: new_key.private_key
                    });
                })
                .catch(err => {
                    console.error(err);
                    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
                        created: false,
                        private_key: private_key,
                        error: 'Cannot add new Google Analytics access token.'
                    });
                })
        }
    })
};

const updateFbKey = (req, res) => {
    FbToken.update({
        api_key: FbToken.api_key
    }, {
        where: {
            user_id: req.user.id
        }
    }).then(up_key => {
        return res.status(HttpStatus.OK).send({
            updated: true,
            api_key: FbToken.api_key
        })
    }).catch(err => {
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            updated: false,
            api_key: FbToken.api_key,
            error: 'Cannot update the Facebook key'
        })
    })
};

const updateGaData = (req, res) => {
    GaToken.update({
        client_email: GaToken.client_email,
        private_key: GaToken.private_key
    }, {
        where: {
            user_id: req.user.id
        }
    }).then(up_key => {
        return res.status(HttpStatus.OK).send({
            updated: true,
            client_email: GaToken.client_email,
            private_key: GaToken.private_key
        })
    }).catch(err => {
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            updated: false,
            client_email: GaToken.client_email,
            private_key: GaToken.private_key,
            error: 'Cannot update the Google Analytics credentials'
        })
    })
};

const deleteFbKey = (req, res) => {
    FbToken.destroy({
        where: {
            user_id: req.user.id
        }
    }).then(del => {
        return res.status(HttpStatus.OK).send({
            deleted: true,
            message: 'Facebook token deleted successfully'
        })
    }).catch(err => {
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            deleted: false,
            error: 'Cannot delete the Facebook key'
        })
    })
};

const deleteGaData = (req, res) => {
    GaToken.destroy({
        where: {
            user_id: req.user.id
        }
    }).then(del => {
        return res.status(HttpStatus.OK).send({
            deleted: true,
            message: 'Google Analytics data deleted successfully'
        })
    }).catch(err => {
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
            deleted: false,
            error: 'Cannot delete the key'
        })
    })
};

const upsertFbKey = async (user_id, token) => {

    let userFind, result;

    try {
        userFind = await FbToken.findOne({where: {user_id: user_id}});

        // If an occurrence alread exists, then update it, else insert a new row
        if(userFind) {
            result = await FbToken.update({api_key: token}, {where: {user_id: user_id}});
        } else {
            result = await FbToken.create({user_id: user_id, api_key: token});
        }

        return !!result;
    } catch (err) {
        console.error(err);
        return false;
    }
};

const upsertGaKey = async (user_id, token) => {
    let userFind, result;

    try {
        userFind = await GaToken.findOne({where: {user_id: user_id}});

        console.log('user_id: ' + token);
        console.log('tokToAdd: ' + token);

        // If an occurrence alread exists, then update it, else insert a new row
        if(userFind) {
            result = await GaToken.update({private_key: token}, {where: {user_id: user_id}});
        } else {
            result = await GaToken.create({user_id: user_id, private_key: token});
        }

        return !!result;
    } catch (err) {
        console.error(err);
        return false;
    }
};

const getPageToken = async (token) => { // TODO edit
    const options = {
        method: GET,
        uri: 'https://graph.facebook.com/me/accounts',
        qs: {
            access_token: token
        }
    };

    try {
        const response = JSON.parse(await Request(options));
        return response['data'][0]['access_token'];
    } catch (e) {
        console.error(e);
        return null;
    }
};

const checkFBContains = (scopes) => {
    const hasManage  = scopes.includes('manage_pages');
    const hasInsight = scopes.includes('read_insights');
    const hasAdsRead = scopes.includes('ads_read');
    const hasAudNet  = scopes.includes('read_audience_network_insights');

    return hasManage & hasInsight & hasAdsRead & hasAudNet;
};

const checkIGContains = (scopes) => {
    const hasBasic   = scopes.includes('instagram_basic');
    const hasInsight = scopes.includes('instagram_manage_insights');

    return hasBasic & hasInsight;
};

const checkGAContains = (scopes) => {

    const hasEmail = !!scopes.find(el => el.includes('userinfo.email'));
    const hasPlus = !!scopes.find(el => el.includes('plus.me'));
    const hasAnalytics = !!scopes.find(el => el.includes('analytics.readonly'));

    return hasEmail & hasAnalytics & hasPlus;
};

const checkYTContains = (scopes) => {
    const hasEmail = !!scopes.find(el => el.includes('userinfo.email'));
    const hasPlus = !!scopes.find(el => el.includes('plus.me'));
    const hasAnalytics = !!scopes.find(el => el.includes('yt-analytics.readonly'));
    const hasMonetary = !!scopes.find(el => el.includes('yt-analytics-monetary.readonly'));

    return hasEmail & hasPlus & hasMonetary & hasAnalytics;
};

module.exports = {readAllKeysById, insertKey, update, deleteKey, upsertFbKey, upsertGaKey, checkExistence, permissionGranted, checkFbTokenValidity};