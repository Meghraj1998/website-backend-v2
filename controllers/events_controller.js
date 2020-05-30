const kue = require("../config/Scheduler/kue");
const worker = require("../config/Scheduler/worker");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("fs");
const { promisify } = require("util");
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const mkdirAsync = promisify(fs.mkdir);
const unlinkAsync = promisify(fs.unlink);

const ObjectId = require("mongoose").Types.ObjectId;
const { AVATAR_URL } = require("../config/index");
// import http status codes
const { BAD_REQUEST, FORBIDDEN } = require("../utility/statusCodes");
// import constants
const { USER_HASH_LENGTH, EVENT_HASH_LENGTH } = require("../config/index");
// import helper functions
const {
	sendError,
	sendSuccess,
	generateHash,
	escapeRegex,
	formatHtmlDate,
	checkToken,
	setToken,
	getImageKey
} = require("../utility/helpers");

const { uploadImage, deleteImage } = require("../config/imageService");

getPushObject = (part, attendInd) => {
	return {
		id: part._id,
		name: part.name,
		branch: part.branch,
		year: part.year,
		phone: part.phone,
		email: part.email,
		attendance: part.attend[attendInd].attend
	};
};

module.exports.getParticipants = async (req, res) => {
	let { eventId, query, branch, year, sortBy } = req.query;
	let filters = {};

	if (eventId) {
		filters["events.event"] = new ObjectId(eventId);
	}

	if (query) {
		const regex = new RegExp(escapeRegex(query), "gi");
		filters.$or = [{ name: regex }, { email: regex }, { branch: regex }];
	}
	if (branch) {
		filters.branch = branch;
	}
	if (year) {
		filters.year = Number(year);
	}

	let sortObj = {};
	if (sortBy) {
		sortBy.map(sort => {
			if (sort === "createdAt") {
				sortObj[sort] = "desc";
			} else {
				sortObj[sort] = "asc";
			}
		});
	} else {
		sortObj = {
			createdAt: "desc",
			branch: "asc",
			year: "asc",
			name: "asc"
		};
	}

	let participants = await Participant.find(filters).sort(sortObj);
	let data = {
		totalParticipants: participants.length,
		participants
	};
	sendSuccess(res, data);
};

module.exports.registerParticipant = async (req, res) => {
	let { name, email, branch, year, phone } = req.body;
	let participant = await Participant.findOne({
		$or: [
			{ email: { $regex: `^${email}$`, $options: "i" } },
			{
				$and: [
					{ name: { $regex: `^${name}$`, $options: "i" } },
					{ branch },
					{ year },
					{
						$or: [
							{ email: { $regex: `^${email}$`, $options: "i" } },
							{ phone }
						]
					}
				]
			}
		]
	});

	if (participant) {
		sendError(res, "Already Registered!!", BAD_REQUEST);
	} else {
		let password = await generateHash(USER_HASH_LENGTH);
		participant = new Participant({
			name,
			email,
			branch,
			year,
			phone,
			password,
			events: [],
			image: `${AVATAR_URL}${
				Math.floor(Math.random() * 10000) + 9999
			}.svg`
		});
		participant = await participant.save();
		const token = participant.generateAuthToken();
		setToken(String(participant._id), token);
		let args = {
			jobName: "sendLoginCreds",
			time: Date.now(),
			params: {
				email,
				password,
				name,
				role: "Participant"
			}
		};
		kue.scheduleJob(args);
		sendSuccess(res, participant);
	}
};

module.exports.updateParticipant = async (req, res) => {
	let { name, email } = req.body;

	let participant = await Participant.findById(req.params.id);

	if (!participant)
		return sendError(res, "Participant not found!!", BAD_REQUEST);

	if (name && name !== participant.name) {
		setToken(req.query.id, "revalidate");
	}

	if (email && email !== participant.email) {
		setToken(req.query.id, "revalidate");
	}

	participant = await Participant.findByIdAndUpdate(
		req.params.id,
		{ $set: req.body },
		{ new: true }
	);

	sendSuccess(res, participant);
};

module.exports.participantLogin = async (req, res) => {
	let { email, password } = req.body;
	let participant = await Participant.findOne({
		email: { $regex: `^${email}$`, $options: "i" }
	});
	if (!participant) return sendError(res, "Invalid User", BAD_REQUEST);
	const validPassword = await participant.isValidPwd(String(password).trim());
	if (!validPassword) return sendError(res, "Invalid Password", BAD_REQUEST);
	participant.lastLogin = new Date(Date.now()).toISOString();
	await participant.save();
	let token = await checkToken(String(participant._id));
	if (token) {
		if (token === "revoked") {
			return sendError(res, "Account Revoked, Logout!", FORBIDDEN);
		} else if (token === "revalidate") {
			token = participant.generateAuthToken();
			setToken(String(participant._id), token);
		}
	} else {
		return sendError(res, "Account Suspended, Logout!", FORBIDDEN);
	}
	sendSuccess(res, participant, token);
};

module.exports.toggleRevoke = async (req, res) => {
	let { id } = req.params;
	let part = await Participant.findById(id);
	if (!part) {
		return sendError(res, "Invalid participant", BAD_REQUEST);
	}
	//toggle the revoke status of part
	part.isRevoked = part.isRevoked ? false : true;

	//change token status
	part.isRevoked ? setToken(id, "revoke") : setToken(id, "revalidate");

	part = await part.save();
	sendSuccess(res, part);
};

module.exports.registerForEvent = async (req, res) => {
	let { eventId } = req.body;
	if (!eventId) {
		return sendError(res, "Invalid Event!!", BAD_REQUEST);
	}

	let [participant, event] = await Promise.all([
		Participant.findById(req.user.id),
		Event.findById(eventId)
	]);

	if (!participant || !event) {
		return sendError(res, "Invalid Request!!", BAD_REQUEST);
	}

	if (event.registrations >= event.maxRegister) {
		return sendError(
			res,
			"Maximum registrations limit reached!!",
			BAD_REQUEST
		);
	}

	let eventIndex = participant.events
		.map(evnt => {
			return String(evnt.event);
		})
		.indexOf(String(eventId));

	if (eventIndex !== -1) {
		return sendError(res, "Already Registered!!", BAD_REQUEST);
	}

	let attendance = new Attendance({
		participant: new ObjectId(req.user.id),
		event: new ObjectId(eventId),
		attend: []
	});

	participant.events.push({
		event: new ObjectId(eventId),
		attendance: new ObjectId(attendance._id),
		status: "not attended"
	});

	if (event.maxRegister === event.registrations + 1) {
		event.isRegistrationOpened = false;
	}

	event.registrations++;

	[participant, attendance, event] = await Promise.all([
		participant.save(),
		attendance.save(),
		event.save()
	]);
	sendSuccess(res, event);
};

module.exports.participantData = async (req, res) => {
	let matchObj = {};

	if (req.user.role === "participant") {
		matchObj._id = new ObjectId(req.user.id);
	} else if (req.query.participantId) {
		matchObj._id = new ObjectId(req.query.participantId);
	} else {
		return sendError(res, "Invalid Request!!", BAD_REQUEST);
	}

	let [participant] = await Participant.aggregate([
		{
			$match: matchObj
		},
		{
			$lookup: {
				from: "events",
				localField: "events.event",
				foreignField: "_id",
				as: "eventsList"
			}
		},
		{
			$project: {
				"eventsList.title": 1,
				"eventsList.description": 1,
				"eventsList.img": 1,
				"eventsList.days": 1,
				"eventsList.startDate": 1,
				"eventsList.endDate": 1,
				"eventsList.venue": 1,
				"eventsList.time": 1,
				"eventsList._id": 1,
				"eventList.maxRegister": 1,
				"eventList.registrations": 1,
				events: 1,
				name: 1,
				email: 1,
				branch: 1,
				year: 1,
				phone: 1
			}
		}
	]);

	if (!participant) {
		return sendError(res, "Participant not found!!", BAD_REQUEST);
	}

	let profileData = {
		name: participant.name,
		email: participant.email,
		branch: participant.branch,
		year: participant.year,
		phone: participant.phone
	};

	let eventsArray = [];
	participant.events.map(event => {
		let eventListIndex = participant.eventsList
			.map(ev => {
				return String(ev._id);
			})
			.indexOf(String(event.event));
		eventsArray.push({
			...event,
			details: participant.eventsList[eventListIndex]
		});
	});

	let data = {
		profileData,
		events: eventsArray
	};

	sendSuccess(res, data);
};

module.exports.deleteParticipant = async (req, res) => {
	let { id } = req.params;
	let part = await Participant.findById(id);

	if (!part) {
		return sendError(res, "Invalid participant", BAD_REQUEST);
	}

	if (part.image && part.image.includes("amazonaws")) {
		let key = `${part.image.split("/")[3]}/${part.image.split("/")[4]}`;
		await deleteImage(key);
	}

	let deletePromises = [
		part.delete(),
		Attendance.deleteOne({ participant: new ObjectId(id) }),
		Feedback.deleteOne({ participant: new ObjectId(id) })
	];

	await Promise.all(deletePromises);
	setToken(id, "delete");
	sendSuccess(res, null);
};

module.exports.getEvents = async (req, res) => {
	let { id } = req.query;
	let events;
	if (id) {
		events = await Event.findById(id);
	} else {
		allEvents = await Event.find().sort({ createdAt: "desc" });

		events = {
			previousEvents: [],
			runningEvents: [],
			upcomingEvents: []
		};

		let currTime = new Date(Date.now()),
			today = new Date(
				currTime.getFullYear(),
				currTime.getMonth(),
				currTime.getDate()
			).toISOString();

		allEvents.map(event => {
			if (today < new Date(event.startDate).toISOString()) {
				events.upcomingEvents.push(event);
			} else if (today > new Date(event.endDate).toISOString()) {
				events.previousEvents.push(event);
			} else {
				events.runningEvents.push(event);
			}
		});
	}
	sendSuccess(res, events);
};

module.exports.addEvent = async (req, res) => {
	let {
		title,
		description,
		days,
		startDate,
		endDate,
		time,
		venue,
		isRegistrationRequired,
		isRegistrationOpened,
		maxRegister
	} = req.body;

	let code = generateHash(EVENT_HASH_LENGTH);

	let event = new Event({
		title,
		description,
		days,
		startDate: formatHtmlDate(startDate).toISOString(),
		endDate: formatHtmlDate(endDate).toISOString(),
		time,
		venue,
		isRegistrationOpened,
		isRegistrationRequired,
		code,
		maxRegister
	});

	if (req.files && req.files.length !== 0) {
		let file = req.files[0];
		let key = getImageKey(req.originalUrl);
		let uploaded = await uploadImage(file, key);
		if (uploaded) {
			event.image = uploaded;
		}
	}
	event = await event.save();
	sendSuccess(res, event);
};

module.exports.changeEventCode = async (req, res) => {
	let { id } = req.body;
	let event = await Event.findById(id);
	if (event) {
		event.code = generateHash(EVENT_HASH_LENGTH);
		event = await event.save();
		sendSuccess(res, event);
	} else {
		sendError(res, "Invalid Event!!", BAD_REQUEST);
	}
};

module.exports.changeEventRegistrationOpen = async (req, res) => {
	let { id } = req.body;
	let event = await Event.findById(id);
	if (event) {
		if (event.registrations === event.maxRegister) {
			return sendError(
				res,
				"Maximum registrations limit reached!!",
				BAD_REQUEST
			);
		} else {
			let isRegistrationOpened = event.isRegistrationOpened
				? false
				: true;
			event = await Event.findByIdAndUpdate(
				id,
				{
					$set: {
						isRegistrationOpened: Boolean(isRegistrationOpened)
					}
				},
				{ new: true }
			);
			sendSuccess(res, event);
		}
	} else {
		sendError(res, "Invalid Event!!", BAD_REQUEST);
	}
};

module.exports.updateEvent = async (req, res) => {
	let { id } = req.params;
	let event = await Event.findById(id);
	if (event) {
		let {
			title,
			description,
			days,
			startDate,
			endDate,
			time,
			venue,
			isRegistrationRequired,
			isRegistrationOpened,
			maxRegister
		} = req.body;

		if (Number(maxRegister) < Number(event.registrations)) {
			return sendError(
				res,
				"Max registrations can't be less than already registered!!",
				BAD_REQUEST
			);
		}
		let updateObj = {
			title,
			description,
			days,
			startDate: formatHtmlDate(startDate).toISOString(),
			endDate: formatHtmlDate(endDate).toISOString(),
			time,
			venue,
			isRegistrationOpened,
			isRegistrationRequired,
			maxRegister
		};

		if (Number(maxRegister) === Number(event.registrations)) {
			updateObj.isRegistrationOpened = false;
		}

		if (req.files && req.files.length !== 0) {
			if (event.image && event.image.includes("amazonaws")) {
				let key = `${event.image.split("/")[3]}/${
					event.image.split("/")[4]
				}`;
				await deleteImage(key);
			}
			let file = req.files[0];
			let key = getImageKey(req.originalUrl);
			let uploaded = await uploadImage(file, key);
			if (uploaded) {
				updateObj.image = uploaded;
			}
		}

		event = await Event.findByIdAndUpdate(id, updateObj, { new: true });
		sendSuccess(res, event);
	} else {
		sendError(res, "Event not found!!", BAD_REQUEST);
	}
};

module.exports.deleteEvent = async (req, res) => {
	let { id } = req.params;
	let event = await Event.findById(id);
	if (event) {
		if (event.image && event.image.includes("amazonaws")) {
			let key = `${event.image.split("/")[3]}/${
				event.image.split("/")[4]
			}`;
			await deleteImage(key);
		}
		let args = {
			jobName: "deleteEvent",
			time: Date.now(),
			params: {
				eventId: new ObjectId(event._id)
			}
		};
		kue.scheduleJob(args);
		sendSuccess(res, null);
	} else {
		sendError(res, "Invalid Event!!", BAD_REQUEST);
	}
};

module.exports.getEventAttendanceReport = async (req, res) => {
	let { event, query, branch, year, presentOn, sortBy } = req.query;

	if (!event) return sendError(res, "Invalid event", BAD_REQUEST);

	let partFilters = {
		"events.event": new ObjectId(event)
	};

	if (query) {
		const regex = new RegExp(escapeRegex(query), "gi");
		partFilters.$or = [
			{ name: regex },
			{ email: regex },
			{ branch: regex }
		];
	}
	if (branch) {
		partFilters.branch = branch;
	}
	if (year) {
		partFilters.year = Number(year);
	}

	let sortObj = {};
	if (sortBy) {
		sortBy.map(sort => {
			if (sort === "createdAt") {
				sortObj[sort] = "desc";
			} else {
				sortObj[sort] = "asc";
			}
		});
	} else {
		sortObj = {
			createdAt: "desc",
			branch: "asc",
			year: "asc",
			name: "asc"
		};
	}

	let participants = await Participant.aggregate([
		{
			$match: partFilters
		},
		{
			$lookup: {
				from: "attendances",
				localField: "events.attendance",
				foreignField: "_id",
				as: "attend"
			}
		},
		{
			$lookup: {
				from: "events",
				localField: "events.event",
				foreignField: "_id",
				as: "events"
			}
		}
	]).sort(sortObj);

	let filteredAttendance = [];

	participants.map(part => {
		let attendInd = part.attend
			.map(att => {
				return String(att.event);
			})
			.indexOf(String(event));
		let eventInd = part.events
			.map(evnt => {
				return String(evnt._id);
			})
			.indexOf(String(event));

		let eveDays = part.events[eventInd].days;
		if (presentOn) {
			if (presentOn === "all") {
				if (part.attend[attendInd].attend.length === eveDays) {
					filteredAttendance.push(getPushObject(part, attendInd));
				}
			} else if (presentOn === "none") {
				if (part.attend[attendInd].attend.length === 0) {
					filteredAttendance.push(getPushObject(part, attendInd));
				}
			} else {
				let day = formatHtmlDate(presentOn).toISOString();
				part.attend[attendInd].attend.map(att => {
					if (new Date(att).toISOString() === day) {
						filteredAttendance.push(getPushObject(part, attendInd));
					}
				});
			}
		} else {
			filteredAttendance.push(getPushObject(part, attendInd));
		}
	});
	sendSuccess(res, filteredAttendance);
};

module.exports.getEventAttendanceStats = async (req, res) => {
	// total registrations
	// total present day wise
	// present 0 days
	// present all days

	let { event } = req.query;

	if (!event) return sendError(res, "Invalid event", BAD_REQUEST);
	let filter = { event: new ObjectId(event) };
	let [
		totalRegistrations,
		present0days,
		presentAlldays,
		eventDetail
	] = await Promise.all([
		Attendance.countDocuments(filter),
		Participant.countDocuments({
			events: {
				$elemMatch: {
					event: new ObjectId(event),
					status: "not attended"
				}
			}
		}),
		Participant.countDocuments({
			events: {
				$elemMatch: { event: new ObjectId(event), status: "attended" }
			}
		}),
		Event.findById(event)
	]);

	if (!event) {
		return sendError(res, "Invalid Event!!", BAD_REQUEST);
	}

	let eveDays = eventDetail.days;

	let dayWiseQueryArray = [],
		i;

	for (let i = 0; i < eveDays; i++) {
		dayWiseQueryArray.push(
			Attendance.countDocuments({
				...filter,
				attend: new Date(
					new Date(eventDetail.startDate).getTime() +
						i * 24 * 60 * 60 * 1000
				).toISOString()
			})
		);
	}

	let dayWiseAttendance = await Promise.all(dayWiseQueryArray);

	let data = {
		totalRegistrations,
		present0days,
		presentAlldays,
		dayWiseAttendance: dayWiseAttendance.slice(0, eveDays)
	};
	return sendSuccess(res, data);
};

module.exports.markUserAttendance = async (req, res) => {
	let { code } = req.body; // event code
	if (!code) {
		return sendError(res, "No Code Received!!", BAD_REQUEST);
	}
	let [event, participant] = await Promise.all([
		Event.findOne({ code }),
		Participant.findById(req.user.id)
	]);
	if (!event) {
		return sendError(res, "Invalid Code!!", BAD_REQUEST);
	}
	let attendance = await Attendance.findOne({
		$and: [{ event: event._id }, { participant: req.user.id }]
	});
	if (!attendance) {
		return sendError(res, "Not Registered in this Event!!", BAD_REQUEST);
	}
	let currTime = new Date(Date.now());
	let today = new Date(
		currTime.getFullYear(),
		currTime.getMonth(),
		currTime.getDate()
	).toISOString();

	if (
		today < new Date(event.startDate).toISOString() ||
		today > new Date(event.endDate).toISOString()
	) {
		return sendError(
			res,
			"Invalid date! Not within event timeline",
			BAD_REQUEST
		);
	}

	let attendIndex = attendance.attend
		.map(attend => {
			return new Date(attend).toISOString();
		})
		.indexOf(today);

	if (attendIndex !== -1) {
		sendError(res, "Already Marked!!", BAD_REQUEST);
	} else {
		attendance.attend.push(today);
		let eventInd = participant.events
			.map(event => {
				return String(event.event);
			})
			.indexOf(String(event._id));
		let daysPresent = attendance.attend.length;
		if (daysPresent < event.days) {
			participant.events[eventInd].status = "partially attended";
		} else {
			participant.events[eventInd].status = "attended";
		}
		await Promise.all([attendance.save(), participant.save()]);
		sendSuccess(res, null);
	}
};

module.exports.getUserEventAttendance = async (req, res) => {
	let { eventId } = req.query;
	let [event, attendance] = await Promise.all([
		Event.findById(eventId),
		Attendance.findOne({
			$and: [{ event: eventId }, { participant: req.user.id }]
		})
	]);

	if (!event || !attendance) {
		return sendError(res, "Invalid Request!!", BAD_REQUEST);
	}

	let data = {
		event,
		attendance: attendance.attend
	};

	return sendSuccess(res, data);
};

module.exports.submitFeedback = async (req, res) => {
	let { eventId, feedback } = req.body;

	if (feedback.length === 0) {
		return sendError(
			res,
			"Atleast one response is required!!",
			BAD_REQUEST
		);
	}
	let [hasGivenFeedback, hasAttendedEvent] = await Promise.all([
		Feedback.findOne({
			participant: req.user.id,
			event: eventId
		}),
		Attendance.findOne({
			event: eventId,
			participant: req.user.id,
			"attend.0": { $exists: true }
		})
	]);
	if (hasGivenFeedback) {
		return sendError(res, "You have already given feedback!!", BAD_REQUEST);
	} else if (!hasAttendedEvent) {
		return sendError(
			res,
			"You have not attended this event!!",
			BAD_REQUEST
		);
	} else {
		let fb = new Feedback({
			participant: new ObjectId(req.user.id),
			event: new ObjectId(eventId),
			feedback
		});
		fb = await fb.save();
		return sendSuccess(res, fb);
	}
};

module.exports.getFeedbackReport = async (req, res) => {
	let { id } = req.params; // event id
	let feedback = await Feedback.aggregate([
		{
			$match: { event: new ObjectId(id) }
		},
		{
			$lookup: {
				from: "participants",
				localField: "participant",
				foreignField: "_id",
				as: "participant"
			}
		},
		{
			$lookup: {
				from: "events",
				localField: "event",
				foreignField: "_id",
				as: "events"
			}
		},
		{
			$project: {
				"events.title": 1,
				"events.description": 1,
				"events.img": 1,
				"events.days": 1,
				"events.startDate": 1,
				"events.endDate": 1,
				"events.venue": 1,
				"events.time": 1,
				"events._id": 1,
				"events.maxRegister": 1,
				"events.registrations": 1,
				"participant.name": 1,
				"participant.email": 1,
				"participant.branch": 1,
				"participant.year": 1,
				"participant.phone": 1,
				feedback: 1
			}
		}
	]).sort({ createdAt: "desc" });

	return sendSuccess(res, feedback);
};

module.exports.previewCerti = async (req, res) => {
	let { name, x, y, size, red, green, blue } = req.body;
	if (!name || !x || !y || !size || !red || !green || !blue) {
		return sendError(res, "All fields required", BAD_REQUEST);
	}

	let file1 = req.files[0],
		file2 = req.files[1];
	let ext1 = path.extname(file1.originalname),
		ext2 = path.extname(file2.originalname);
	let pdfFile, fontFile;

	if (ext1 === ".pdf") {
		if ([".ttf", ".woff", ".woff2"].includes(ext2)) {
			pdfFile = file1;
			fontFile = file2;
		}
	} else if ([".ttf", ".woff", ".woff2"].includes(ext1)) {
		if (ext2 === ".pdf") {
			pdfFile = file2;
			fontFile = file1;
		}
	}
	let fontBytes = fontFile.buffer;
	let pdfBytes = pdfFile.buffer;

	let srcDoc = await PDFDocument.load(pdfBytes);
	let pdfDoc = await PDFDocument.create();
	pdfDoc.registerFontkit(fontkit);
	let customFont = await pdfDoc.embedFont(fontBytes);
	let [designPage] = await pdfDoc.copyPages(srcDoc, [0]);

	designPage.drawText(name, {
		x: Number(x),
		y: Number(y),
		size: Number(size),
		font: customFont,
		color: rgb(Number(red) / 255, Number(green) / 255, Number(blue) / 255)
	});
	pdfDoc.addPage(designPage);
	let newpdfBytes = await pdfDoc.save();

	res.writeHead(200, { "Content-Type": "application/pdf" });
	res.end(new Buffer.alloc(newpdfBytes.length, newpdfBytes), "binary");
};

module.exports.addCerti = async (req, res) => {
	let { x, y, size, red, green, blue } = req.body;
	if (!x || !y || !size || !red || !green || !blue) {
		return sendError(res, "All fields required", BAD_REQUEST);
	}

	let { id } = req.params;
	if (!id) return sendError(res, "Invalid event id", BAD_REQUEST);

	let event = await Event.findById(id);
	if (!event) return sendError(res, "Invalid event", BAD_REQUEST);

	let file1 = req.files[0],
		file2 = req.files[1];
	let ext1 = path.extname(file1.originalname),
		ext2 = path.extname(file2.originalname);
	let pdfFile, fontFile;

	if (ext1 === ".pdf") {
		if ([".ttf", ".woff", ".woff2"].includes(ext2)) {
			pdfFile = file1;
			fontFile = file2;
		}
	} else if ([".ttf", ".woff", ".woff2"].includes(ext1)) {
		if (ext2 === ".pdf") {
			pdfFile = file2;
			fontFile = file1;
		}
	}

	if (!fs.existsSync(`public/certificates/${id}`)) {
		await mkdirAsync(`public/certificates/${id}`, { recursive: true });
	}

	if (event.certificateMeta !== undefined) {
		if (event.certificateMeta.pdfFileName !== pdfFile.originalname) {
			//DELETE prev pdf
			await unlinkAsync(
				`public/certificates/${id}/${event.certificateMeta.pdfFileName}`
			);
		}
		if (event.certificateMeta.fontFileName !== fontFile.originalname) {
			//DELETE prev font
			await unlinkAsync(
				`public/certificates/${id}/${event.certificateMeta.fontFileName}`
			);
		}
	}

	await writeFileAsync(
		`public/certificates/${id}/${pdfFile.originalname}`,
		pdfFile.buffer
	);
	await writeFileAsync(
		`public/certificates/${id}/${fontFile.originalname}`,
		fontFile.buffer
	);

	event.certificateMeta.pdfFileName = pdfFile.originalname;
	event.certificateMeta.fontFileName = fontFile.originalname;
	event.certificateMeta.x = x;
	event.certificateMeta.y = y;
	event.certificateMeta.size = size;
	event.certificateMeta.red = red;
	event.certificateMeta.green = green;
	event.certificateMeta.blue = blue;

	await event.save();

	sendSuccess(res, "Certificate design saved");
};

module.exports.generateCerti = async (req, res) => {
	let { id } = req.params;

	let [event, participant] = await Promise.all([
		Event.findById(id),
		Participant.findById(req.user.id)
	]);

	if (!participant || !event) {
		return sendError(res, "Invalid Request!!", BAD_REQUEST);
	}

	let eventInd = participant.events
		.map(event => {
			return String(event.event);
		})
		.indexOf(String(event._id));

	if (participant.events[eventInd].status === "attended") {
		//get certi meta
		if (event.certificateMeta !== undefined) {
			let {
					pdfFileName,
					fontFileName,
					x,
					y,
					size,
					red,
					green,
					blue
				} = event.certificateMeta,
				{ name } = participant;

			//read the pdf file
			let pdfBytes = await readFileAsync(
				`public/certificates/${id}/${pdfFileName}`
			);
			//read the font file
			let fontBytes = await readFileAsync(
				`public/certificates/${id}/${fontFileName}`
			);

			//generate certi
			let srcDoc = await PDFDocument.load(pdfBytes);
			let pdfDoc = await PDFDocument.create();
			pdfDoc.registerFontkit(fontkit);
			let customFont = await pdfDoc.embedFont(fontBytes);
			let [designPage] = await pdfDoc.copyPages(srcDoc, [0]);

			designPage.drawText(name, {
				x: Number(x),
				y: Number(y),
				size: Number(size),
				font: customFont,
				color: rgb(
					Number(red) / 255,
					Number(green) / 255,
					Number(blue) / 255
				)
			});
			pdfDoc.addPage(designPage);
			let newpdfBytes = await pdfDoc.save();

			res.writeHead(200, { "Content-Type": "application/pdf" });
			res.end(
				new Buffer.alloc(newpdfBytes.length, newpdfBytes),
				"binary"
			);
		} else {
			return sendError(res, "Certificate not ready", BAD_REQUEST);
		}
	} else {
		sendError(res, "Not eligible for certificate", BAD_REQUEST);
	}
};