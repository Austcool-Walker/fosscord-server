import { route } from "@fosscord/api";
import {
	Config,
	DiscordApiErrors,
	emitEvent,
	HTTPError,
	OrmUtils,
	PublicUserProjection,
	Relationship,
	RelationshipAddEvent,
	RelationshipRemoveEvent,
	RelationshipType,
	User
} from "@fosscord/util";
import { Request, Response, Router } from "express";

const router = Router();

const userProjection: (keyof User)[] = ["relationships", ...PublicUserProjection];

router.get("/", route({}), async (req: Request, res: Response) => {
	const user = await User.findOneOrFail({
		where: { id: req.user_id },
		relations: ["relationships", "relationships.to"],
		select: ["relationships"]
	});

	//TODO DTO
	const related_users = user.relationships.map((r) => {
		return {
			id: r.to.id,
			type: r.type,
			nickname: null,
			user: r.to.toPublicUser()
		};
	});

	return res.json(related_users);
});

router.put("/:id", route({ body: "RelationshipPutSchema" }), async (req: Request, res: Response) => {
	return await updateRelationship(
		req,
		res,
		await User.findOneOrFail({
			where: { id: req.params.id },
			relations: ["relationships", "relationships.to"],
			select: userProjection
		}),
		req.body.type ?? RelationshipType.friends
	);
});

router.post("/", route({ body: "RelationshipPostSchema" }), async (req: Request, res: Response) => {
	return await updateRelationship(
		req,
		res,
		await User.findOneOrFail({
			relations: ["relationships", "relationships.to"],
			select: userProjection,
			where: {
				discriminator: String(req.body.discriminator).padStart(4, "0"), //Discord send the discriminator as integer, we need to add leading zeroes
				username: req.body.username
			}
		}),
		req.body.type
	);
});

router.delete("/:id", route({}), async (req: Request, res: Response) => {
	const { id } = req.params;
	if (id === req.user_id) throw new HTTPError("You can't remove yourself as a friend");

	const user = await User.findOneOrFail({ where: { id: req.user_id }, select: userProjection, relations: ["relationships"] });
	const friend = await User.findOneOrFail({ where: { id: id }, select: userProjection, relations: ["relationships"] });

	const relationship = user.relationships.find((x) => x.to_id === id);
	const friendRequest = friend.relationships.find((x) => x.to_id === req.user_id);

	if (!relationship) throw new HTTPError("You are not friends with the user", 404);
	if (relationship?.type === RelationshipType.blocked) {
		// unblock user

		await Promise.all([
			Relationship.delete({ id: relationship.id }),
			emitEvent({
				event: "RELATIONSHIP_REMOVE",
				user_id: req.user_id,
				data: relationship.toPublicRelationship()
			} as RelationshipRemoveEvent)
		]);
		return res.sendStatus(204);
	}
	if (friendRequest && friendRequest.type !== RelationshipType.blocked) {
		await Promise.all([
			Relationship.delete({ id: friendRequest.id }),
			await emitEvent({
				event: "RELATIONSHIP_REMOVE",
				data: friendRequest.toPublicRelationship(),
				user_id: id
			} as RelationshipRemoveEvent)
		]);
	}

	await Promise.all([
		Relationship.delete({ id: relationship.id }),
		emitEvent({
			event: "RELATIONSHIP_REMOVE",
			data: relationship.toPublicRelationship(),
			user_id: req.user_id
		} as RelationshipRemoveEvent)
	]);

	return res.sendStatus(204);
});

export default router;

async function updateRelationship(req: Request, res: Response, friend: User, type: RelationshipType) {
	const id = friend.id;
	if (id === req.user_id) throw new HTTPError("You can't add yourself as a friend");

	const user = await User.findOneOrFail({
		where: { id: req.user_id },
		relations: ["relationships", "relationships.to"],
		select: userProjection
	});

	let relationship = user.relationships.find((x) => x.to_id === id);
	const friendRequest = friend.relationships.find((x) => x.to_id === req.user_id);

	// TODO: you can add infinitely many blocked users (should this be prevented?)
	if (type === RelationshipType.blocked) {
		if (relationship) {
			if (relationship.type === RelationshipType.blocked) throw new HTTPError("You already blocked the user");
			relationship.type = RelationshipType.blocked;
			await relationship.save();
		} else {
			relationship = await (
				OrmUtils.mergeDeep(new Relationship(), { to_id: id, type: RelationshipType.blocked, from_id: req.user_id }) as Relationship
			).save();
		}

		if (friendRequest && friendRequest.type !== RelationshipType.blocked) {
			await Promise.all([
				Relationship.delete({ id: friendRequest.id }),
				emitEvent({
					event: "RELATIONSHIP_REMOVE",
					data: friendRequest.toPublicRelationship(),
					user_id: id
				} as RelationshipRemoveEvent)
			]);
		}

		await emitEvent({
			event: "RELATIONSHIP_ADD",
			data: relationship.toPublicRelationship(),
			user_id: req.user_id
		} as RelationshipAddEvent);

		return res.sendStatus(204);
	}

	const { maxFriends } = Config.get().limits.user;
	if (user.relationships.length >= maxFriends) throw DiscordApiErrors.MAXIMUM_FRIENDS.withParams(maxFriends);

	let incoming_relationship = OrmUtils.mergeDeep(new Relationship(), {
		nickname: undefined,
		type: RelationshipType.incoming,
		to: user,
		from: friend
	});
	let outgoing_relationship = OrmUtils.mergeDeep(new Relationship(), {
		nickname: undefined,
		type: RelationshipType.outgoing,
		to: friend,
		from: user
	});

	if (friendRequest) {
		if (friendRequest.type === RelationshipType.blocked) throw new HTTPError("The user blocked you");
		if (friendRequest.type === RelationshipType.friends) throw new HTTPError("You are already friends with the user");
		// accept friend request
		incoming_relationship = friendRequest as any; //TODO: checkme, any cast
		incoming_relationship.type = RelationshipType.friends;
	}

	if (relationship) {
		if (relationship.type === RelationshipType.outgoing) throw new HTTPError("You already sent a friend request");
		if (relationship.type === RelationshipType.blocked) throw new HTTPError("Unblock the user before sending a friend request");
		if (relationship.type === RelationshipType.friends) throw new HTTPError("You are already friends with the user");
		outgoing_relationship = relationship as any; //TODO: checkme, any cast
		outgoing_relationship.type = RelationshipType.friends;
	}

	await Promise.all([
		incoming_relationship.save(),
		outgoing_relationship.save(),
		emitEvent({
			event: "RELATIONSHIP_ADD",
			data: outgoing_relationship.toPublicRelationship(),
			user_id: req.user_id
		} as RelationshipAddEvent),
		emitEvent({
			event: "RELATIONSHIP_ADD",
			data: {
				...incoming_relationship.toPublicRelationship(),
				should_notify: true
			},
			user_id: id
		} as RelationshipAddEvent)
	]);

	return res.sendStatus(204);
}
