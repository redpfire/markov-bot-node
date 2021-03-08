'use strict';

const Discord = require('discord.js');
const client = new Discord.Client();
const Database = require('better-sqlite3');
const upath = require('upath');
const sqlite3 = require('sqlite3');
const open = require('sqlite').open;
const Markov = require('markov-strings').default;
const markov = new Markov({ stateSize: 2});
const rwc = require('random-weighted-choice');
const urlRegex = require('url-regex');

const config = require(upath.joinSafe(__dirname, 'volume/config.json'));

const fun = {};

const isAdmin = (channel, user) => {
    // is admin in the channel or the owner
    if (user.id === config.owner || channel.permissionsFor(user).FLAGS & 0x8) {
        return true;
    }

    return false;
};

(async () => {
    const db = await open({
        filename: upath.joinSafe(__dirname, 'volume/cache.db'),
        driver: sqlite3.Database
    });
    await db.migrate({ force: false });
    await db.close();
})();

const db = new Database(upath.joinSafe(__dirname, 'volume/cache.db'));

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('message', async msg => {
    if (msg.author.bot) return;

    const args = msg.content.split(' ');
    let embed = new Discord.MessageEmbed();

    // if prefix is empty and conversation channel is defined
    if ((msg.channel.id === config.convoCID && !args[0].startsWith(config.prefix)) ||
        args[0] === `${config.prefix}mk`) { // fallback to command mode

        try {
            const start = process.hrtime();
            let sentence = markov.generate({
                maxTries: config.maxTries,
                prng: Math.random,
                filter: result => {
                    return result.refs.length > config.complexity;
                }
            });
            const elapsed = (process.hrtime(start)[1] / 1000000).toFixed(3);
            fun.lastElapsed = elapsed;

            const includeLink = rwc([
                { weight: 1.2, id: true },
                { weight: 5, id: false}
            ]);

            if (includeLink === 'true') {
                const urls = db.prepare('SELECT url FROM msgs WHERE url IS NOT NULL').pluck().all();
                const selectedUrl = urls[Math.floor(Math.random() * urls.length)];
                sentence.string += `\n${selectedUrl}`;
            }

            fun.lastMarkov = sentence;

            await msg.channel.send(sentence.string.replace(/<@.*>/, ''));
        } catch(e) {
            await msg.channel.send("I'm just dumb lol");
        }
    }
    else {
        switch(args[0]) {
            case `${config.prefix}mkstats`:
            case `${config.prefix}mkstatus`:
            case `${config.prefix}mkstate`:
                const linesNo = db.prepare('SELECT COUNT(*) FROM msgs WHERE content IS NOT NULL').pluck().get();
                const urlsNo = db.prepare('SELECT COUNT(*) FROM msgs WHERE url IS NOT NULL').pluck().get();
                const iNo = db.prepare('SELECT COUNT(*) FROM msgs WHERE userId NOT LIKE ?').pluck().get('0');
                const channels = db.prepare('SELECT DISTINCT channelId FROM msgs WHERE channelId NOT LIKE ?').pluck().all('0').reduce((a, cid) => {
                    a += ` <#${cid}>`;
                    return a;
                }, '').slice(1);

                embed.setColor('BLURPLE');
                embed.setTitle('Bot stats');
                embed.setThumbnail(client.user.displayAvatarURL());
                embed.setTimestamp();
                embed.addField('Lines', linesNo, true);
                embed.addField('Impersonable Lines', iNo, true);
                embed.addField('Urls', urlsNo, true);
                if (fun.lastElapsed)
                    embed.addField('Last generation time', `${fun.lastElapsed} ms`);
                embed.addField('Channels cached', channels);

                msg.channel.send(embed);
                break;
            case `${config.prefix}mkhold`:
                if (!isAdmin(msg.channel, msg.author)) break;

                config.hold = !config.hold;
                msg.reply('Ok. Flipped the hold flag.');
                break;
            case `${config.prefix}mkeval`:
                if (!isAdmin(msg.channel, msg.author)) break;
                const toEval = args.slice(1).join(' ');

                embed.setColor('BLURPLE');
                embed.setTitle('Eval results');
                embed.setFooter('node.js');
                embed.setTimestamp();
                embed.addField(':inbox_tray: Input', `\`\`\`${toEval}\`\`\``);

                try {
                    const evaled = JSON.stringify(eval(toEval), null, 2);
                    embed.addField(':outbox_tray: Output', `\`\`\`${evaled}\`\`\``);
                } catch (e) {
                    embed.addField(':outbox_tray: Output', `\`\`\` \`\`\``);
                    embed.addField(':x: Error', `\`\`\`${e}\`\`\``);
                }

                msg.channel.send(embed);
                break;
            case `${config.prefix}mkblacklist`:
                if (args.length < 2) break;
                if (!isAdmin(msg.channel, msg.author)) break;

                try {
                    db.prepare('INSERT INTO blacklist VALUES (?, ?)')
                        .run(args[1], msg.guild.id);

                    await msg.reply(`Added <#${args[1]}> to blacklist.`);
                } catch(_) {
                    await msg.reply(`<#${args[1]}> already in blacklist.`);
                }
                break;

            case `${config.prefix}mkunblacklist`:
                if (args.length < 2) break;
                if (!isAdmin(msg.channel, msg.author)) break;

                db.prepare('DELETE FROM blacklist WHERE channelId=? AND guildId=?')
                    .run(args[1], msg.guild.id);

                await msg.reply(`Removed <#${args[1]}> from blacklist.`);
                break;

            case `${config.prefix}mkprune`:
                if (args.length < 2) break;
                if (!isAdmin(msg.channel, msg.author)) break;

                try {
                    db.prepare('DELETE FROM msgs WHERE channelId=?').run(args[1]);

                    await msg.reply('Prune successful.');
                } catch(e) {
                    await msg.reply('Prune not successful.');
                }
                break;

            default:
                if (config.hold) break;
                if (msg.content === '') break;

                const inBlacklist = db.prepare('SELECT * FROM blacklist WHERE channelId=?').pluck().get(msg.channel.id);
                if (inBlacklist) return;

                console.log(`Adding "${msg.content}"`);
                let toAdd = [msg];

                const channelCached = db.prepare('SELECT id FROM msgs WHERE channelId=?').pluck().get(msg.channel.id);

                if (!channelCached) {
                    const msgs = await msg.channel.messages.fetch({ limit: config.fetchLimit }).then(m => m.array());
                    toAdd = toAdd.concat(msgs);
                    console.log(`Uncached channel ${msg.channel.name}. Caching ${toAdd.length-1} messages.`);
                }

                const insert = db.prepare('INSERT INTO msgs VALUES(NULL,?,?,?,?)');

                const insertAll = db.transaction((toInsert) => {
                    for (const m of toInsert) {
                        const userId = m.author.id;
                        const channelId = m.channel.id;
                        let content = m.content;

                        const first = m.attachments.first();
                        let url = first ? first.url : null;

                        const r = urlRegex({exact: false});

                        if (!url && r.test(m.content)) {
                            url = m.content.match(r)[0];
                            if (url === m.content) content = null;

                            console.log(`Also found a url: "${url}"`);
                        }

                        try {
                            insert.run(userId, channelId, url, content);
                            if (content)
                                markov.addData([content]);
                        } catch (e) {
                            if (toAdd.length == 1)
                                console.log(`Rejected. Not unique. (${m.author.id}: ${m.id})`);
                        }
                    }
                });

                insertAll(toAdd);
                break;
        }
    }
});

// load data
const data = db.prepare('SELECT content FROM msgs WHERE content IS NOT NULL').pluck().all();

console.log(`Preparing ${data.length} lines.`);

if (data.length)
    markov.addData(data);

console.log(`Loaded ${data.length} lines.`);

client.login(config.token);
