const Joi = require('joi');
const { baseSchema } = require('@steem-monsters/sl-secrets-loader/secrets-schemas');

const secrets = [
	{
		configName: 'active_key',
		envVar: 'SM_ACTIVE_KEY',
		secretLocation: 'keys/smActiveKey',
		secretValueKey: 'active_key',
		keyOverrideEnvVar: 'AWS_SM_ACTIVEKEY_SECRET',
	},
];

const secretsConfigSchema = baseSchema
	.append({
		active_key: Joi.string().required(),
	})
	.options({ abortEarly: false });

module.exports = { secrets, secretsConfigSchema };
