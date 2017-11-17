ALTER TABLE `sessions` CHANGE `json`
`json` longblob NOT NULL AFTER `uuid`;